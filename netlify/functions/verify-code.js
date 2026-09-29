// This runs on Netlify's servers, not in the visitor's browser.
//
// Checks whether an access code is genuine and still active, and locks it
// to the device it is used on.
//
// Kinds of code (all signed with ACCESS_CODE_SECRET, so they can't be faked):
//   SE-xxxxxxxxxx-eeeeeeee-yyyyyy : Family plan purchase code (30 days, expiry built in)
//   SC-xxxxxxxxxx-eeeeeeee-yyyyyy : Class plan purchase code  (30 days, expiry built in)
//   SE-xxxxxxxxxx-yyyyyy          : OLD early-tester code (valid through Sept 29, 2026)
//   SF-xxxxxxxxxx-yyyyyy          : a family/student code made from a purchase code.
//                                   Ends when its purchase code ends; can be turned off.
//
// Device lock: a purchase code works on up to 2 devices (e.g. phone + laptop);
// a family/student code works on 1 device. The owner can "Reset device" for a
// family/student code from Settings (reset-device.js).

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();
const OWNER_DEVICES = 2;
const MEMBER_DEVICES = 1;

function sig6(secret, text){
  return crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 6).toUpperCase();
}
function same(a, b){
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Checks a purchase code (SE- Family or SC- Class).
function checkOwnerCode(code, secret){
  const c = String(code || '').trim().toUpperCase();
  let m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    const exp = parseInt(m[2], 16) * 1000;
    return Date.now() < exp ? { valid: true, plan: 'family', expiresAt: exp } : { valid: false, reason: 'expired', expiresAt: exp };
  }
  m = c.match(/^SC-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, 'CLASS' + m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    const exp = parseInt(m[2], 16) * 1000;
    return Date.now() < exp ? { valid: true, plan: 'class', expiresAt: exp } : { valid: false, reason: 'expired', expiresAt: exp };
  }
  m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1]), m[2])) return { valid: false, reason: 'invalid' };
    return Date.now() < OLD_FORMAT_CUTOFF_MS ? { valid: true, plan: 'family', expiresAt: null } : { valid: false, reason: 'expired' };
  }
  return { valid: false, reason: 'invalid' };
}

// Adds this device to the code's list if there's room. Returns true if allowed.
async function claimDevice(code, deviceId, max){
  const store = getStore('code-devices');
  const list = (await store.get(code, { type: 'json' })) || [];
  if (list.includes(deviceId)) return true;
  if (list.length >= max) return false;
  list.push(deviceId);
  await store.setJSON(code, list);
  return true;
}

function reply(body){
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const secret = process.env.ACCESS_CODE_SECRET;
    if (!secret) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' }) };
    }

    const { code, deviceId } = JSON.parse(event.body || '{}');
    const cleaned = String(code || '').trim().toUpperCase();
    const device = String(deviceId || '');
    if (!/^[0-9a-f]{16,64}$/i.test(device)) {
      return reply({ valid: false, reason: 'refresh' });   // an old copy of the app is open
    }

    // Family / student code
    const fam = cleaned.match(/^SF-([0-9A-F]{10})-([0-9A-F]{6})$/);
    if (fam) {
      if (!same(sig6(secret, fam[1]), fam[2])) return reply({ valid: false, reason: 'invalid' });
      const rec = await getStore('family-codes').get(cleaned, { type: 'json' });
      if (!rec || rec.revoked === true) return reply({ valid: false, reason: 'invalid' });
      const owner = checkOwnerCode(rec.ownerCode, secret);
      if (!owner.valid) return reply({ valid: false, reason: owner.reason === 'expired' ? 'expired' : 'invalid' });
      if (!(await claimDevice(cleaned, device, MEMBER_DEVICES))) return reply({ valid: false, reason: 'device', role: 'member' });
      return reply({ valid: true, role: 'member', plan: owner.plan, expiresAt: owner.expiresAt ? new Date(owner.expiresAt).toISOString() : undefined });
    }

    // Purchase code
    const owner = checkOwnerCode(cleaned, secret);
    if (!owner.valid) {
      return reply({ valid: false, reason: owner.reason, expiresAt: owner.expiresAt ? new Date(owner.expiresAt).toISOString() : undefined });
    }
    if (!(await claimDevice(cleaned, device, OWNER_DEVICES))) return reply({ valid: false, reason: 'device', role: 'owner' });
    return reply({ valid: true, role: 'owner', plan: owner.plan, expiresAt: owner.expiresAt ? new Date(owner.expiresAt).toISOString() : undefined });
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
