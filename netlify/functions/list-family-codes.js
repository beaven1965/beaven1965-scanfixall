// This runs on Netlify's servers, not in the visitor's browser.
//
// Given the site owner's original SE- purchase code, returns every family
// code created under it (name, code, and whether it's currently on/off),
// so Settings can show a manageable list.

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const { ownerCode } = JSON.parse(event.body || '{}');
    const cleanedOwner = (ownerCode || '').trim().toUpperCase();

    if (!cleanedOwner.match(/^SE-[0-9A-F]{10}-[0-9A-F]{6}$/)) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: [] }) };
    }

    const store = getStore('family-codes');
    const indexKey = 'index:' + cleanedOwner;
    const codeList = (await store.get(indexKey, { type: 'json' })) || [];

    const codes = [];
    for (const code of codeList) {
      const record = await store.get(code, { type: 'json' });
      if (record) {
        codes.push({
          code,
          label: record.label,
          createdAt: record.createdAt,
          revoked: !!record.revoked
        });
      }
    }

    codes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
