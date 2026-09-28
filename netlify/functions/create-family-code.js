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

    // The owner's code can be the OLD style (SE-xxxxxxxxxx-yyyyyy) or the
    // NEW style with an expiry date built in (SE-xxxxxxxxxx-eeeeeeee-yyyyyy).
    const oldOwner = cleanedOwner.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
    const newOwner = cleanedOwner.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
    if (!oldOwner && !newOwner) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only your original access code can be used to create family codes.' }) };
    }

    const signedPart = newOwner ? newOwner[1] + newOwner[2] : oldOwner[1];
    const ownerSignature = newOwner ? newOwner[3] : oldOwner[2];
    const expectedOwnerSig = crypto
      .createHmac('sha256', accessSecret)
      .update(signedPart)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase();

    if (!signaturesMatch(expectedOwnerSig, ownerSignature)) {
      return { statusCode: 403, body: JSON.stringify({ error: "That access code doesn't look right." }) };
    }

    if (newOwner && Date.now() >= parseInt(newOwner[2], 16) * 1000) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Your access code has expired. Please renew to create family codes.' }) };
    }

    // Limit: up to 3 active family codes per purchase (turned-off codes don't count).
    const MAX_FAMILY_CODES = 3;
    const limitStore = getStore('family-codes');
    const existing = (await limitStore.get('index:' + cleanedOwner, { type: 'json' })) || [];
    let active = 0;
    for (const fc of existing) {
      const rec = await limitStore.get(fc, { type: 'json' });
      if (rec && !rec.revoked) active++;
    }
    if (active >= MAX_FAMILY_CODES) {
      return { statusCode: 403, body: JSON.stringify({ error: 'You already have ' + MAX_FAMILY_CODES + ' active family codes. Turn one off to create a new one.' }) };
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
