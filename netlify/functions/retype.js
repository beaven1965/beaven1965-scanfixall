// This runs on Netlify's servers, not in the visitor's browser.
//
// "Retype as new document" (Premium only).
// Receives a photo of a cleaned page and the user's Premium access code.
// 1. Checks the access code is real and still active — using the exact same
//    check as verify-code.js — so free users can't run up AI costs.
// 2. Asks Claude to read the page and return the text with its layout
//    (paragraphs, address lines, bold, alignment), leaving out letterheads,
//    logos, stamps and handwritten signatures.
// The browser then lays the text out on a clean new page the user can edit.

const verifyCode = require('./verify-code.js');
const { getStore, connectLambda } = require('@netlify/blobs');

// Limit: 100 retyped pages per month per purchase. Family codes share
// the pages of the purchase code that created them.
const MONTHLY_PAGE_LIMIT = 100;

function monthKey(){
  // Month in Philippine time, e.g. "2026-09".
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

const MODEL = 'claude-haiku-4-5-20251001'; // fast enough for Netlify's time limit

const INSTRUCTIONS = `You are retyping a photographed paper document so it can be printed fresh.

Read the page image and return ONLY a JSON object, no other text, in this shape:
{
  "blocks": [
    { "type": "lines", "align": "left", "text": "first line\\nsecond line" },
    { "type": "paragraph", "align": "justify", "text": "Flowing body text with **bold words** kept." }
  ],
  "signerBlock": 7,
  "letterhead": { "found": true, "top": 0.0, "bottom": 0.12 }
}

Rules:
- Copy the words exactly as printed. Do not fix grammar, spelling or wording. Do not add anything.
- Mark bold text with **double asterisks**.
- Use "paragraph" for flowing body text that wraps across lines (align "justify" if the original is justified, otherwise "left").
- Use "lines" where each line break matters: dates, addresses, salutations, closings like "Respectfully yours,", signer name and title lines, contact details. Put each line on its own line with \\n.
- "align" is "left", "center", "right" or "justify" — match the original.
- Keep the blocks in the same order as the page. One block per paragraph or group of lines.
- LEAVE OUT: letterheads, logos, seals, stamps, watermarks, handwritten signatures, handwritten initials, page numbers, and anything that is not part of the page (phone screen buttons, background objects).
- If a word cannot be read, write [?] in its place.
- "letterhead" describes the printed letterhead band at the TOP of the page (organization name, logo, seal, address header, usually above the date). "top" and "bottom" are where that band starts and ends, as a fraction of the page height from 0 (top edge) to 1 (bottom edge). Make the band cover the whole letterhead including any line under it, but no body text. If there is no letterhead, use { "found": false, "top": 0, "bottom": 0 }.
- "signerBlock" is the index (starting at 0) of the block holding the printed name of the person who signs, usually right after the closing. Use -1 if there is none.`;

function json(status, body){
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json(500, { error: 'Retype is not set up yet: the server is missing ANTHROPIC_API_KEY as a Netlify environment variable.' });

    const { code, image } = JSON.parse(event.body || '{}');
    if (!code) return json(403, { error: 'Retype is a Premium feature. Please unlock Premium first.' });

    // Same check as the Unlock button uses.
    const check = await verifyCode.handler({ ...event, httpMethod: 'POST', body: JSON.stringify({ code }) });
    const checked = JSON.parse(check.body || '{}');
    if (check.statusCode !== 200) return json(500, { error: checked.error || 'Could not check your access code right now.' });
    if (!checked.valid) {
      return json(403, { error: checked.reason === 'expired'
        ? 'Your Premium code has expired. Please renew to use Retype.'
        : 'Retype is a Premium feature. Your access code could not be confirmed.' });
    }

    // Which purchase does this code belong to? (Family codes count against their owner.)
    connectLambda(event);
    const cleaned = String(code).trim().toUpperCase();
    let owner = cleaned;
    if (cleaned.startsWith('SF-')) {
      const rec = await getStore('family-codes').get(cleaned, { type: 'json' });
      if (rec && rec.ownerCode) owner = rec.ownerCode;
    }
    const usageStore = getStore('retype-usage');
    const usageKey = owner + ':' + monthKey();
    const used = Number(await usageStore.get(usageKey)) || 0;
    if (used >= MONTHLY_PAGE_LIMIT) {
      return json(429, { error: "You've used all " + MONTHLY_PAGE_LIMIT + ' Retype pages for this month. They reset on the 1st. Clean paper still works without limits.', pagesLeft: 0 });
    }

    const match = (image || '').match(/^data:image\/(jpeg|png);base64,(.+)$/);
    if (!match) return json(400, { error: 'No page picture was received. Please try again.' });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/' + match[1], data: match[2] } },
            { type: 'text', text: INSTRUCTIONS }
          ]
        }]
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(502, { error: 'The reading service had a problem (' + res.status + '). Please try again in a moment.' });
    }

    const text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    let parsed = null;
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) {}
    if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      return json(502, { error: 'Could not read any text on that page. Try a clearer photo.' });
    }

    const allowedTypes = ['paragraph', 'lines'];
    const allowedAlign = ['left', 'center', 'right', 'justify'];
    const signerIdx = Number.isInteger(parsed.signerBlock) ? parsed.signerBlock : -1;
    const kept = parsed.blocks
      .map((b, i) => ({ b, isSigner: i === signerIdx }))
      .filter(({ b }) => b && typeof b.text === 'string' && b.text.trim());
    const blocks = kept.map(({ b }) => ({
      type: allowedTypes.includes(b.type) ? b.type : 'paragraph',
      align: allowedAlign.includes(b.align) ? b.align : 'left',
      text: b.text.slice(0, 5000)
    }));
    const signerBlock = kept.findIndex(k => k.isSigner);

    let letterhead = { found: false, top: 0, bottom: 0 };
    const lh = parsed.letterhead;
    if (lh && lh.found === true && typeof lh.top === 'number' && typeof lh.bottom === 'number') {
      const top = Math.max(0, Math.min(1, lh.top)), bottom = Math.max(0, Math.min(0.6, lh.bottom));
      if (bottom - top > 0.02) letterhead = { found: true, top, bottom };
    }

    // Count the page only after it was read successfully.
    await usageStore.set(usageKey, String(used + 1));
    const pagesLeft = Math.max(0, MONTHLY_PAGE_LIMIT - used - 1);

    return json(200, { blocks, signerBlock, letterhead, pagesLeft });
  } catch (err) {
    return json(500, { error: err.message || 'Something went wrong while retyping.' });
  }
};
