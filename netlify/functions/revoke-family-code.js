// This runs on Netlify's servers, not in the visitor's browser.
//
// Turns a family code on or off. Only works if the ownerCode supplied
// matches the one that originally created that family code — so nobody
// can turn off a code they didn't issue.

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const { ownerCode, code, revoked } = JSON.parse(event.body || '{}');
    const cleanedOwner = (ownerCode || '').trim().toUpperCase();
    const cleanedCode = (code || '').trim().toUpperCase();

    if (!cleanedCode.match(/^SF-[0-9A-F]{10}-[0-9A-F]{6}$/)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That doesn\'t look like a family code.' }) };
    }

    const store = getStore('family-codes');
    const record = await store.get(cleanedCode, { type: 'json' });

    if (!record) {
      return { statusCode: 404, body: JSON.stringify({ error: 'That code was not found.' }) };
    }
    if (record.ownerCode !== cleanedOwner) {
      return { statusCode: 403, body: JSON.stringify({ error: 'That code was not created by you.' }) };
    }

    record.revoked = !!revoked;
    await store.setJSON(cleanedCode, record);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
