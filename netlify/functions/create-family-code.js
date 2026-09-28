// This runs on Netlify's servers, not in the visitor's browser.
//
// Given the site owner's original SE- purchase code and a family member's
// name, creates a new SF- family code: signed the same way as a real
// purchase code (so it can't be forged), but also recorded in Netlify
// Blobs so it can be tracked and turned on/off later from Settings.
// Only a real SE- code can create family codes — a family code can't be
// used to create further family codes.

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

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

    const { ownerCode, label } = JSON.parse(event.body || '{}');
    const cleanedOwner = (ownerCode || '').trim().toUpperCase();
    const cleanedLabel = (label || '').trim().slice(0, 60);

    if (!cleanedLabel) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please type a name for this family member.' }) };
    }

    const ownerMatch = cleanedOwner.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
    if (!ownerMatch) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only your original access code can be used to create family codes.' }) };
    }

    const [, ownerRandom, ownerSignature] = ownerMatch;
    const expectedOwnerSig = crypto
      .createHmac('sha256', accessSecret)
      .update(ownerRandom)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase();

    if (!signaturesMatch(expectedOwnerSig, ownerSignature)) {
      return { statusCode: 403, body: JSON.stringify({ error: "That access code doesn't look right." }) };
    }

    const newRandom = crypto.randomBytes(5).toString('hex').toUpperCase();
    const newSignature = crypto
      .createHmac('sha256', accessSecret)
      .update(newRandom)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase();
    const newCode = 'SF-' + newRandom + '-' + newSignature;

    const store = getStore('family-codes');
    await store.setJSON(newCode, {
      label: cleanedLabel,
      ownerCode: cleanedOwner,
      createdAt: new Date().toISOString(),
      revoked: false
    });

    const indexKey = 'index:' + cleanedOwner;
    const existingIndex = (await store.get(indexKey, { type: 'json' })) || [];
    existingIndex.push(newCode);
    await store.setJSON(indexKey, existingIndex);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: newCode })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
