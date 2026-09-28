// This runs on Netlify's servers, not in the visitor's browser.
//
// Checks whether an access code is one this server genuinely issued —
// without needing to store a list of every code anywhere. It works
// because every code is "random text + signature", and only this server
// (using ACCESS_CODE_SECRET) can produce a matching signature.
//
// There are three kinds of code:
//   SE-xxxxxxxxxx-yyyyyy         : OLD-format code (no expiry built in) —
//     issued to early testers before subscriptions existed. These are
//     valid right up through Sept 29, 2026 (Asia/Manila), and stop
//     working after that, exactly as promised to testers. No lookup
//     needed — just a signature check plus today's date.
//   SE-xxxxxxxxxx-eeeeeeee-yyyyyy : NEW-format code (with an 8-hex-digit
//     expiry timestamp built in) — issued after a real payment from
//     Sept 2026 onward. Valid for 30 days from the moment it was issued,
//     checked entirely from the code itself, no lookup needed.
//   SF-xxxxxxxxxx-yyyyyy         : a family code created from Settings.
//     Signature-checked the same way, but ALSO checked against Netlify
//     Blobs so it can be turned off later by whoever created it.

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

// Early-tester codes (old format, no expiry segment) stop working after
// this moment — end of day Sept 29, 2026, Philippine time — regardless of
// signature validity. This is the one place that date lives.
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

function signaturesMatch(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const accessSecret = process.env.ACCESS_CODE_SECRET;
    if (!accessSecret) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' }) };
    }

    const { code } = JSON.parse(event.body || '{}');
    const cleaned = (code || '').trim().toUpperCase();

    // Try the NEW format first (has an expiry segment built in).
    const newFormat = cleaned.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
    if (newFormat) {
      const [, randomPart, expiryHex, signature] = newFormat;
      const expected = crypto
        .createHmac('sha256', accessSecret)
        .update(randomPart + expiryHex)
        .digest('hex')
        .slice(0, 6)
        .toUpperCase();

      if (!signaturesMatch(expected, signature)) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'invalid' }) };
      }

      const expiresAtMs = parseInt(expiryHex, 16) * 1000;
      const stillValid = Date.now() < expiresAtMs;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid: stillValid,
          reason: stillValid ? undefined : 'expired',
          expiresAt: new Date(expiresAtMs).toISOString()
        })
      };
    }

    // Fall back to the OLD format (early-tester codes, no expiry segment).
    const oldFormat = cleaned.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
    if (oldFormat) {
      const [, randomPart, signature] = oldFormat;
      const expected = crypto
        .createHmac('sha256', accessSecret)
        .update(randomPart)
        .digest('hex')
        .slice(0, 6)
        .toUpperCase();

      const signatureOk = signaturesMatch(expected, signature);
      const withinTesterWindow = Date.now() < OLD_FORMAT_CUTOFF_MS;
      const valid = signatureOk && withinTesterWindow;

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid,
          reason: valid ? undefined : (signatureOk ? 'expired' : 'invalid')
        })
      };
    }

    // Family (SF-) code: signature, then has to exist and not be turned off.
    const familyFormat = cleaned.match(/^SF-([0-9A-F]{10})-([0-9A-F]{6})$/);
    if (familyFormat) {
      const [, randomPart, signature] = familyFormat;
      const expected = crypto
        .createHmac('sha256', accessSecret)
        .update(randomPart)
        .digest('hex')
        .slice(0, 6)
        .toUpperCase();

      if (!signaturesMatch(expected, signature)) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'invalid' }) };
      }

      const store = getStore('family-codes');
      const record = await store.get(cleaned, { type: 'json' });
      const valid = !!record && record.revoked !== true;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valid, reason: valid ? undefined : 'invalid' }) };
    }

    // Didn't match any known shape at all.
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'invalid' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
