// This runs on Netlify's servers, not in the visitor's browser.
//
// Recovery path for when a real payment succeeded but the browser tab
// closed, crashed, or clicked PayMongo's misleadingly-labeled "click to
// cancel" link before the app could show the success screen and issue a
// code. Given just the Payment ID (visible on PayMongo's own receipt
// screen, and in the Billing/transactions tab of the PayMongo dashboard),
// this looks the payment up directly with PayMongo, confirms it's really
// "paid", and issues a genuine access code.
//
// Safeguard: each Payment ID can only ever produce ONE code. If the same
// Payment ID is submitted again, the same code is returned again (not a
// new one) — stored in Netlify Blobs, the same way family codes already
// are elsewhere in this app.

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const CODE_VALID_DAYS = 30;

// Class Plan payments are ₱1,500; anything at or above this amount gets a
// Class code (SC-), anything below gets a Family code (SE-).
const CLASS_MIN_CENTAVOS = 150000;

// Issues a code good for 30 days from right now. The expiry is baked
// into the code itself (as 8 hex digits of a Unix timestamp), so
// verify-code.js can check it later with no database lookup at all.
// Class codes are signed with "CLASS" in front, so a Family code can't
// be turned into a Class code by changing its first letters.
function issueAccessCode(secret, plan) {
  const randomPart = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex characters
  const expiresAtMs = Date.now() + CODE_VALID_DAYS * 24 * 60 * 60 * 1000;
  const expiryHex = Math.floor(expiresAtMs / 1000).toString(16).toUpperCase().padStart(8, '0');
  const isClass = plan === 'class';
  const signature = crypto
    .createHmac('sha256', secret)
    .update((isClass ? 'CLASS' : '') + randomPart + expiryHex)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return { code: `${isClass ? 'SC' : 'SE'}-${randomPart}-${expiryHex}-${signature}`, expiresAt: new Date(expiresAtMs).toISOString(), plan: isClass ? 'class' : 'family' };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const secretKey = process.env.PAYMONGO_SECRET_KEY;
    const accessSecret = process.env.ACCESS_CODE_SECRET;
    if (!secretKey || !accessSecret) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Server is missing PAYMONGO_SECRET_KEY or ACCESS_CODE_SECRET.' })
      };
    }

    const { payment_id } = JSON.parse(event.body || '{}');
    const cleanedId = (payment_id || '').trim();
    if (!cleanedId.startsWith('pay_')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid Payment ID — it should start with "pay_".' }) };
    }

    // Already recovered before? Hand back the same code instead of making a new one.
    const store = getStore('recovered-payments');
    const existing = await store.get(cleanedId, { type: 'json' });
    if (existing && existing.code) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: existing.code, expiresAt: existing.expiresAt, alreadyRecovered: true })
      };
    }

    const res = await fetch(`https://api.paymongo.com/v1/payments/${cleanedId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(secretKey + ':').toString('base64') }
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not find that payment with PayMongo (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    const attrs = data && data.data && data.data.attributes;
    const status = attrs && attrs.status;

    if (status !== 'paid') {
      return { statusCode: 402, body: JSON.stringify({ error: 'PayMongo shows this payment\'s status as "' + status + '", not "paid" yet.' }) };
    }

    const paidCentavos = Number(attrs && attrs.amount) || 0;
    const { code, expiresAt, plan } = issueAccessCode(accessSecret, paidCentavos >= CLASS_MIN_CENTAVOS ? 'class' : 'family');
    await store.setJSON(cleanedId, { code, expiresAt, plan, recoveredAt: new Date().toISOString() });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, expiresAt, plan })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
