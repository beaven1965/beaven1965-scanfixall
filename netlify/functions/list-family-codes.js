// This runs on Netlify's servers, not in the visitor's browser.
//
// Given a purchase code (SE- Family or SC- Class), returns every family /
// student code created under it: name, code, on/off, and whether it is
// already in use on a device — so Settings can show a manageable list.

const { getStore, connectLambda } = require('@netlify/blobs');

const MAX_CODES = { family: 5, class: 50 };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    connectLambda(event);

    const { ownerCode } = JSON.parse(event.body || '{}');
    const cleanedOwner = String(ownerCode || '').trim().toUpperCase();
    const plan = cleanedOwner.startsWith('SC-') ? 'class' : 'family';

    if (!cleanedOwner.match(/^S[EC]-[0-9A-F]{10}-([0-9A-F]{8}-)?[0-9A-F]{6}$/)) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: [], plan, max: MAX_CODES[plan] }) };
    }

    const store = getStore('family-codes');
    const devices = getStore('code-devices');
    const codeList = (await store.get('index:' + cleanedOwner, { type: 'json' })) || [];

    const codes = [];
    for (const code of codeList) {
      const record = await store.get(code, { type: 'json' });
      if (record) {
        const used = (await devices.get(code, { type: 'json' })) || [];
        codes.push({
          code,
          label: record.label,
          createdAt: record.createdAt,
          revoked: !!record.revoked,
          hasDevice: used.length > 0
        });
      }
    }
    codes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes, plan, max: MAX_CODES[plan] })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
