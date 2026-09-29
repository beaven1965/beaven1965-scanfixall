// This runs on Netlify's servers, not in the visitor's browser.
//
// "Retype as new document" (Premium) — careful version.
// Uses the stronger Claude Sonnet model, which needs more than Netlify's
// usual 10-second limit, so this is a *streaming* function (allowed up to
// 60 seconds): it sends a few blank spaces while it waits, then the answer.
// Blank space before JSON is still valid JSON, so the app just reads it all.
//
// Steps:
// 1. Check the Premium access code (same rules as verify-code.js).
// 2. Check the page limit: 100 Retype pages per payment (per purchase code),
//    shared with its family/student codes. No carry-over: each new payment
//    gives a new code, so the count starts again at zero.
// 3. Ask Claude to read the page — never guessing — and return the layout.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-5';
const PAGE_LIMIT = { family: 100, class: 100 };   // pages per 30-day payment
const TOO_LONG_MSG = 'This page has too much writing to read in one go. Drag the gold corner dots to include only the part you need (for example, just the handwritten part), then tap Retype again. You were not charged for this page.';
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

const INSTRUCTIONS = `You are retyping a photographed paper document so it can be printed fresh. Accuracy matters more than anything: this may be an official letter, and a wrong name, place or word could embarrass the sender.

Read the page image slowly, word by word, and return ONLY a JSON object, no other text, in this shape:
{
  "blocks": [
    { "type": "lines", "align": "left", "text": "first line\\nsecond line" },
    { "type": "paragraph", "align": "justify", "text": "Flowing body text with **bold words** kept." }
  ],
  "signerBlock": 7,
  "letterhead": { "found": true, "top": 0.0, "bottom": 0.12 }
}

Accuracy rules — the most important part:
- Copy every word EXACTLY as printed, letter by letter. Keep the original spelling, capitals, punctuation (a colon stays a colon), and wording.
- NEVER guess, and NEVER replace a word with a similar or "more sensible" word. Names of people, streets, places, events and organizations are often unusual — copy them exactly as the letters appear.
- If you cannot read a word with confidence (crease, stain, blur, fold), write [?] in its place instead of guessing. If part of a word is readable, still write [?] for the whole word. It is much better to write [?] than a wrong word.
- NUMBERS NEED EXTRA CARE: dates, years, amounts, money, phone numbers, ID/license numbers, room numbers and times. If you are not completely sure of EVERY digit, write [?] in place of the WHOLE number (for example "Sept. 18, [?]" or "Room [?]"). Never pick the most likely-looking digit. Handwritten digits like 1/7, 4/9, 5/6, 0/6 and 1/2 are easy to confuse — when in doubt, [?].
- Do not fix grammar or spelling. Do not add, remove or reorder anything.

Layout rules:
- Mark bold text with **double asterisks**, exactly where the original is bold.
- Use "paragraph" for flowing body text that wraps across lines (align "justify" if the original is justified, otherwise "left").
- Use "lines" where each line break matters: dates, addresses, salutations, closings like "Respectfully yours,", signer name and title lines, contact details. Put each line on its own line with \\n.
- "align" is "left", "center", "right" or "justify" — match the original.
- Keep the blocks in the same order as the page. One block per paragraph or group of lines.
- LEAVE OUT: letterheads, logos, seals, stamps, watermarks, handwritten signatures, handwritten initials, page numbers, and anything that is not part of the page (phone screen buttons, background objects).
- "letterhead" describes the printed letterhead band at the TOP of the page (organization name, logo, seal, address header, usually above the date). "top" and "bottom" are where that band starts and ends, as a fraction of the page height from 0 (top edge) to 1 (bottom edge). Make the band cover the whole letterhead including any line under it, but no body text. If there is no letterhead, use { "found": false, "top": 0, "bottom": 0 }.
- "signerBlock" is the index (starting at 0) of the block holding the printed name of the person who signs, usually right after the closing. Use -1 if there is none.`;

const NOTES_INSTRUCTIONS = `You are retyping a photographed page of handwritten CLASS NOTES (a notebook page, pad paper or handout) so a student or teacher can read and print them neatly. Accuracy matters more than anything.

Read the page slowly, word by word, and return ONLY a JSON object, no other text, in this shape:
{
  "blocks": [
    { "type": "lines", "align": "left", "text": "**Photosynthesis**" },
    { "type": "lines", "align": "left", "text": "• Happens in the chloroplast\\n• Needs sunlight, water and CO2" },
    { "type": "paragraph", "align": "left", "text": "A sentence or two of flowing notes." }
  ],
  "signerBlock": -1,
  "letterhead": { "found": false, "top": 0, "bottom": 0 }
}

Accuracy rules — the most important part:
- Copy every word EXACTLY as written, letter by letter, including cursive. Keep the student's own spelling, abbreviations (w/, b/c, =, →) and wording. Do not fix grammar or spelling, and do not add, remove or reorder anything.
- NEVER guess. If you cannot read a word with confidence, write [?] in its place. It is much better to write [?] than a wrong word.
- NUMBERS NEED EXTRA CARE: dates, years, formulas, measurements, amounts and page numbers. If you are not completely sure of EVERY digit or symbol, write [?] for the whole number or formula part.
- Keep words in Filipino or other languages exactly as written; do not translate.

Layout rules for notes:
- Titles, topics and headings: their own "lines" block, wrapped in **double asterisks**.
- Words the writer underlined, boxed, circled or highlighted as key terms: wrap them in **double asterisks** too.
- Bulleted or dashed items: one item per line, starting with "• ". Numbered or lettered items: keep the writer's own "1." "2." "a." "b.". Put a list in one "lines" block with \\n between items.
- Sub-points written further to the right: start the line with two spaces then "– ".
- Sentences that flow across lines: "paragraph" blocks, align "left".
- Formulas and equations: copy them on their own line in a "lines" block, as plain text (for example "A = πr²", "H2O", "x^2 + 3x = 10").
- LEAVE OUT: notebook ruled lines, margin lines, holes, page numbers printed on the notebook, doodles, drawings and anything that is not part of the page. If there is a drawing or diagram, put a line "[drawing]" where it is.
- Keep the blocks in the same order as the page.
- Always return "signerBlock": -1 and "letterhead": { "found": false, "top": 0, "bottom": 0 }.`;

function sig6(secret, text){
  return crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 6).toUpperCase();
}
function same(a, b){
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Same rules as verify-code.js. Returns { valid, reason, owner, plan }.
async function checkCode(code, secret){
  const c = String(code || '').trim().toUpperCase();
  let m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    if (Date.now() >= parseInt(m[2], 16) * 1000) return { valid: false, reason: 'expired' };
    return { valid: true, owner: c, plan: 'family' };
  }
  m = c.match(/^SC-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, 'CLASS' + m[1] + m[2]), m[3])) return { valid: false, reason: 'invalid' };
    if (Date.now() >= parseInt(m[2], 16) * 1000) return { valid: false, reason: 'expired' };
    return { valid: true, owner: c, plan: 'class' };
  }
  m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1]), m[2])) return { valid: false, reason: 'invalid' };
    if (Date.now() >= OLD_FORMAT_CUTOFF_MS) return { valid: false, reason: 'expired' };
    return { valid: true, owner: c, plan: 'family' };
  }
  m = c.match(/^SF-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1]), m[2])) return { valid: false, reason: 'invalid' };
    const rec = await getStore('family-codes').get(c, { type: 'json' });
    if (!rec || rec.revoked === true) return { valid: false, reason: 'invalid' };
    const ownerCheck = await checkCode(rec.ownerCode, secret);   // family codes end with their owner's code
    if (!ownerCheck.valid) return { valid: false, reason: ownerCheck.reason };
    return { valid: true, owner: rec.ownerCode, plan: ownerCheck.plan };
  }
  return { valid: false, reason: 'invalid' };
}

async function doRetype(body, deadline){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const secret = process.env.ACCESS_CODE_SECRET;
  if (!apiKey) return { error: 'Retype is not set up yet: the server is missing ANTHROPIC_API_KEY as a Netlify environment variable.' };
  if (!secret) return { error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' };

  const { code, image } = body || {};
  const notes = body && body.mode === 'notes';
  if (!code) return { error: 'Retype is a Premium feature. Please unlock Premium first.' };
  const checked = await checkCode(code, secret);
  if (!checked.valid) {
    return { error: checked.reason === 'expired'
      ? 'Your Premium code has expired. Please renew to use Retype.'
      : 'Retype is a Premium feature. Your access code could not be confirmed.' };
  }

  const limit = PAGE_LIMIT[checked.plan] || 100;
  const usageStore = getStore('retype-pages');
  const usageKey = checked.owner;              // one count per payment (per purchase code)
  const used = Number(await usageStore.get(usageKey)) || 0;
  if (used >= limit) {
    return { error: "You've used all " + limit + ' Retype pages for this 30-day period. You get ' + limit + ' new pages when you renew. Clean paper still works without limits.', pagesLeft: 0 };
  }

  const match = String(image || '').match(/^data:image\/(jpeg|png);base64,(.+)$/);
  if (!match) return { error: 'No page picture was received. Please try again.' };

  // Ask Claude with streaming, so we can stop cleanly before Netlify's
  // 60-second limit instead of being cut off with no answer at all.
  const abort = new AbortController();
  const msLeft = Math.max(5000, deadline - Date.now());
  const timer = setTimeout(() => abort.abort(), msLeft);
  let text = '', stopReason = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        stream: true,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/' + match[1], data: match[2] } },
          { type: 'text', text: notes ? NOTES_INSTRUCTIONS : INSTRUCTIONS }
        ] }]
      })
    });
    if (!res.ok) {
      clearTimeout(timer);
      return { error: 'The reading service had a problem (' + res.status + '). Please try again in a moment.' };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') text += ev.delta.text;
        else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        else if (ev.type === 'error') { clearTimeout(timer); return { error: 'The reading service had a problem. Please try again in a moment.' }; }
      }
    }
  } catch (err) {
    clearTimeout(timer);
    if (abort.signal.aborted) return { error: TOO_LONG_MSG, tooLong: true };
    throw err;
  }
  clearTimeout(timer);
  if (stopReason === 'max_tokens') return { error: TOO_LONG_MSG, tooLong: true };

  let parsed = null;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
  if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
    return { error: 'Could not read any text on that page. Try a clearer photo.' };
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
  if (!notes && lh && lh.found === true && typeof lh.top === 'number' && typeof lh.bottom === 'number') {
    const top = Math.max(0, Math.min(1, lh.top)), bottom = Math.max(0, Math.min(0.6, lh.bottom));
    if (bottom - top > 0.02) letterhead = { found: true, top, bottom };
  }

  await usageStore.set(usageKey, String(used + 1));   // count only successful pages
  return { blocks, signerBlock, letterhead, pagesLeft: Math.max(0, limit - used - 1) };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller){
      const started = Date.now();
      controller.enqueue(enc.encode(' '));                                  // start the stream right away
      const keepAlive = setInterval(() => controller.enqueue(enc.encode(' ')), 3000);
      let result;
      try { result = await doRetype(body, started + 52000); }
      catch (err) { result = { error: err.message || 'Something went wrong while retyping.' }; }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify(result)));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};
