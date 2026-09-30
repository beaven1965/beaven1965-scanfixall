// This runs on Netlify's servers, not in the visitor's browser.
//
// After a visitor comes back from PayMongo's checkout page, index.html
// calls this function with the Checkout Session ID it saved (in the
// browser's sessionStorage) just before sending them to PayMongo.
//
// This function asks PayMongo directly — using our secret key — whether
// that specific session was actually paid. Only if PayMongo confirms the
// payment do we hand back an access code. This stops someone from simply
// typing "?paid=success" into the address bar to get a free code.
//
// The access code itself needs no database: it's a random code plus an
// expiry timestamp plus a signature made with a secret only this server
// knows (ACCESS_CODE_SECRET). Anyone can type the code into Settings
// later — including on a different device or a family member's phone —
// and verify-code.js can check it's genuine, and still within its 30-day
// window, just by recalculating the signature and reading the expiry.
//
// Safeguard (matches verify-payment-by-id.js): each Checkout Session ID
// can only ever produce ONE code. If this function is called again for a
// session it already confirmed — e.g. the success page reloads, or the
// same request happens twice — it returns that same saved code instead
// of minting a brand new one. Stored in Netlify Blobs, same store name
// used by the by-Payment-ID recovery function, so both paths share one
// list and can never issue two different codes for the same purchase.

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
        body: JSON.stringify({ error: 'Server is missing PAYMONGO_SECRET_KEY or ACCESS_CODE_SECRET as a Netlify environment variable.' })
      };
    }

    const { session_id } = JSON.parse(event.body || '{}');
    if (!session_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing session_id — this browser may not have the payment info saved (e.g. a different tab was used).' }) };
    }

    // Already confirmed and coded before? Hand back the same code instead of making a new one.
    const store = getStore('recovered-payments');
    const storeKey = `session:${session_id}`;
    const existing = await store.get(storeKey, { type: 'json' });
    if (existing && existing.code) {
      await getStore('paid-codes').set(existing.code, '1');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: existing.code, expiresAt: existing.expiresAt, alreadyIssued: true })
      };
    }

    const res = await fetch(`https://api.paymongo.com/v2/checkout_sessions/${session_id}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(secretKey + ':').toString('base64') }
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not confirm this payment with PayMongo (' + res.status + ').', detail: errText }) };
    }

    const data = await res.json();
    const attrs = data && data.data && data.data.attributes;
    const paymentIntentStatus =
      attrs && attrs.payment_intent && attrs.payment_intent.attributes && attrs.payment_intent.attributes.status;
    const hasRecordedPayments = attrs && Array.isArray(attrs.payments) && attrs.payments.length > 0;
    const isPaid = paymentIntentStatus === 'succeeded' || hasRecordedPayments;

    if (!isPaid) {
      return { statusCode: 402, body: JSON.stringify({ error: 'PayMongo has not confirmed this payment yet. Please wait a moment and try again.' }) };
    }

    // How much was paid? (Read from PayMongo, never from the browser.)
    const firstPayment = attrs && Array.isArray(attrs.payments) && attrs.payments[0];
    const lineItem = attrs && Array.isArray(attrs.line_items) && attrs.line_items[0];
    const paidCentavos = Number(firstPayment && firstPayment.attributes && firstPayment.attributes.amount)
      || Number(lineItem && lineItem.amount) || 0;
    const { code, expiresAt, plan } = issueAccessCode(accessSecret, paidCentavos >= CLASS_MIN_CENTAVOS ? 'class' : 'family');
    await store.setJSON(storeKey, { code, expiresAt, plan, issuedAt: new Date().toISOString() });
    await getStore('paid-codes').set(code, JSON.stringify({ plan, paidAt: new Date().toISOString() }));   // counts as a paid code (60 AI pages Family / 100 Class)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, expiresAt, plan })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
