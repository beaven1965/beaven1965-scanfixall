// This runs on Netlify's servers, not in the visitor's browser.
//
// Given a purchase code and a person's name, creates a new SF- code for a
// family member (Family plan) or a student (Class plan). The new code is
// signed like a purchase code (so it can't be forged) and recorded in
// Netlify Blobs so the owner can see it, turn it off, or reset its device.
// Only a purchase code (SE- or SC-) can create these codes.

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();
const MAX_CODES = { family: 5, class: 50 };

function sig6(secret, text){
  return crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 6).toUpperCase();
}
function same(a, b){
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function checkOwnerCode(code, secret){
  const c = String(code || '').trim().toUpperCase();
  let m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    return Date.now() < parseInt(m[2], 16) * 1000 ? { valid: true, plan: 'family' } : { valid: false, reason: 'expired' };
  }
  m = c.match(/^SC-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, 'CLASS' + m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    return Date.now() < parseInt(m[2], 16) * 1000 ? { valid: true, plan: 'class' } : { valid: false, reason: 'expired' };
  }
  m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1]), m[2])) return { valid: false, reason: 'invalid' };
    return Date.now() < OLD_FORMAT_CUTOFF_MS ? { valid: true, plan: 'family' } : { valid: false, reason: 'expired' };
  }
  return { valid: false, reason: 'notOwner' };
}

function json(status, body){
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    connectLambda(event);

    const secret = process.env.ACCESS_CODE_SECRET;
    if (!secret) return json(500, { error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' });

    const { ownerCode, label } = JSON.parse(event.body || '{}');
    const cleanedOwner = String(ownerCode || '').trim().toUpperCase();
    const cleanedLabel = String(label || '').trim().slice(0, 60);
    if (!cleanedLabel) return json(400, { error: 'Please type a name first.' });

    const owner = checkOwnerCode(cleanedOwner, secret);
    if (!owner.valid) {
      if (owner.reason === 'expired') return json(403, { error: 'Your access code has expired. Please renew to create codes.' });
      if (owner.reason === 'notOwner') return json(403, { error: 'Only the purchase code can create family or student codes.' });
      return json(403, { error: "That access code doesn't look right." });
    }

    // Limit: active codes per purchase (turned-off codes don't count).
    const max = MAX_CODES[owner.plan];
    const store = getStore('family-codes');
    const indexKey = 'index:' + cleanedOwner;
    const existing = (await store.get(indexKey, { type: 'json' })) || [];
    let active = 0;
    for (const fc of existing) {
      const rec = await store.get(fc, { type: 'json' });
      if (rec && !rec.revoked) active++;
    }
    if (active >= max) {
      const who = owner.plan === 'class' ? 'student' : 'family';
      return json(403, { error: 'You already have ' + max + ' active ' + who + ' codes. Turn one off to create a new one.' });
    }

    const newRandom = crypto.randomBytes(5).toString('hex').toUpperCase();
    const newCode = 'SF-' + newRandom + '-' + sig6(secret, newRandom);

    await store.setJSON(newCode, {
      label: cleanedLabel,
      ownerCode: cleanedOwner,
      createdAt: new Date().toISOString(),
      revoked: false
    });
    existing.push(newCode);
    await store.setJSON(indexKey, existing);

    return json(200, { code: newCode });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
