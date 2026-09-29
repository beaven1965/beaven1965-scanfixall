// This runs on Netlify's servers, not in the visitor's browser.
//
// "Reset device" — lets the owner of a purchase code free up one of their
// family/student codes so it can be used on a new phone (for example, when
// the member changed phones or cleared their browser).
// Only works if ownerCode is the purchase code that created that code.

const { getStore, connectLambda } = require('@netlify/blobs');

function json(status, body){
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    connectLambda(event);

    const { ownerCode, code } = JSON.parse(event.body || '{}');
    const cleanedOwner = String(ownerCode || '').trim().toUpperCase();
    const cleanedCode = String(code || '').trim().toUpperCase();

    if (!cleanedCode.match(/^SF-[0-9A-F]{10}-[0-9A-F]{6}$/)) {
      return json(400, { error: "That doesn't look like a family or student code." });
    }

    const record = await getStore('family-codes').get(cleanedCode, { type: 'json' });
    if (!record) return json(404, { error: 'That code was not found.' });
    if (record.ownerCode !== cleanedOwner) return json(403, { error: 'That code was not created by you.' });

    await getStore('code-devices').setJSON(cleanedCode, []);
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
