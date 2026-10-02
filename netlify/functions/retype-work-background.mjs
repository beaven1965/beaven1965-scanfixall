// This runs on Netlify's servers as a BACKGROUND function (up to 15 minutes),
// so long, crowded pages (like a prescription pad full of printed text) have
// time to be read completely. Netlify answers the phone right away with
// "202 accepted"; the finished result is saved and the phone collects it
// through retype-job.mjs ("status").
//
// Steps: 1) retype-job "start" saves the photo and gives a ticket (jobId)
//        2) this function reads the page and saves the result under the ticket
//        3) retype-job "status" hands the result to the phone
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-5';
const PAGE_LIMIT = { family: 60, class: 100 };    // AI pages per 30-day PAID code (Family ₱250 / Class ₱1,500)
const FREE_PAGE_LIMIT = 3;                          // free (trial) codes: 3 AI pages in total

// 🎁 Free load: a phone/laptop with no code gets FREE_PAGE_LIMIT AI pages, one time, counted as 'free:<device>'.
const FREE_DAILY_ALL = 60;   // safety cap: free pages for everyone together per day (protects the AI bill)
const validDevice = (d) => /^[0-9a-f]{16,64}$/i.test(String(d || ''));
async function checkCodeOrFree(code, secret, device){
  if (!String(code || '').trim()) {
    return validDevice(device) ? { valid: true, owner: 'free:' + String(device).toLowerCase(), plan: 'free', free: true } : { valid: false, reason: 'refresh' };
  }
  return checkCode(code, secret);
}
const phDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
async function freeDayFull(checked){
  if (!checked.free) return false;
  return (Number(await getStore('retype-pages').get('free-day:' + phDay())) || 0) >= FREE_DAILY_ALL;
}
async function bumpFreeDay(checked){
  if (!checked.free) return;
  const st = getStore('retype-pages'), k = 'free-day:' + phDay();
  await st.set(k, String((Number(await st.get(k)) || 0) + 1));
}
const BUSY = 'ScanFixAll is very busy today, so the free AI pages are paused until tomorrow. Scanning, Clean paper, Shrink and Sign still work.';

// Paid codes are marked in the 'paid-codes' store by verify-payment when PayMongo
// confirms the payment. Any other code is a free promo code. The owner can also
// list codes (comma-separated) in the PAID_CODES environment variable.
async function pageLimitFor(checked){
  const owner = checked.owner;
  const extra = String(process.env.PAID_CODES || '').toUpperCase().split(',').map(t => t.trim()).filter(Boolean);
  const paid = extra.includes(owner) || !!(await getStore('paid-codes').get(owner));
  return { paid, limit: paid ? (PAGE_LIMIT[checked.plan] || 60) : FREE_PAGE_LIMIT };
}
function limitReachedMsg(limit, paid){
  return paid
    ? "You've used all " + limit + ' AI pages (Retype, Translate, Listen) for this 30-day period. You get ' + limit + ' new pages when you renew. Scanning, Clean paper, Shrink, Sign, Share and Print stay free.'
    : "You've used your " + limit + ' free AI pages (Retype, Translate, Listen). Get Premium (₱250 a month) for 60 AI pages every month. Scanning, Clean paper, Shrink, Sign, Share and Print stay free.';
}
const TOO_LONG_MSG = 'This page has too much writing to read in one go. Drag the gold corner dots to include only the part you need (for example, just the handwritten part), then tap Retype again. You were not charged for this page.';
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

const INSTRUCTIONS = `You are retyping a photographed paper document so it can be printed fresh. Accuracy matters more than anything: this may be an official letter, and a wrong name, place or word could embarrass the sender.

Read the page image slowly, word by word, and return ONLY a JSON object, no other text, in this shape:
{
  "blocks": [
    { "type": "lines", "align": "left", "text": "first line\\nsecond line" },
    { "type": "paragraph", "align": "justify", "text": "Flowing body text with **bold words** kept." },
    { "type": "table", "header": 1, "rows": [["INDICATORS", "1", "2", "NO*"], ["1. Apply knowledge of content (1.1.2)", "", "", ""]] }
  ],
  "signerBlock": 7,
  "letterhead": { "found": true, "top": 0.0, "bottom": 0.12 }
}

Accuracy rules — the most important part:
- Copy every word EXACTLY as printed, letter by letter. Keep the original spelling, capitals, punctuation (a colon stays a colon), and wording.
- NEVER guess, and NEVER replace a word with a similar or "more sensible" word. Names of people, streets, places, events and organizations are often unusual — copy them exactly as the letters appear.
- If you cannot read a word with confidence (crease, stain, blur, fold), write [?] in its place instead of guessing. If part of a word is readable, still write [?] for the whole word. It is much better to write [?] than a wrong word.
- NUMBERS NEED EXTRA CARE: dates, years, amounts, money, phone numbers, ID/license numbers, room numbers and times. If you are not completely sure of EVERY digit, write [?] in place of the WHOLE number (for example "Sept. 18, [?]" or "Room [?]"). Never pick the most likely-looking digit. Handwritten digits like 1/7, 4/9, 5/6, 0/6 and 1/2 are easy to confuse — when in doubt, [?].
- NAMES NEED EXTRA CARE: people's names, titles and initials, and names of schools, places and events. Handwritten names cannot be checked against a dictionary, so only copy a name if you can clearly see EVERY letter. If any letter of a name is unclear, write [?] for that WHOLE name part (for example "[?] D. Miranda" or "Heriberto [?] D. Miranda"). Never swap in a common name that looks similar.
- NEVER ADD words that are not on the page — not titles like "Hon.", "Mr.", "Dr." or "Engr.", not missing words, not punctuation that isn't there.
- Final check before answering: look again at every name, title, date and number you wrote. If you would not bet on each letter and digit being exactly right, change it to [?].
- Do not fix grammar or spelling. Do not add, remove or reorder anything.

Layout rules:
- Mark bold text with **double asterisks**, exactly where the original is bold.
- Use "paragraph" for flowing body text that wraps across lines (align "justify" if the original is justified, otherwise "left").
- Use "lines" where each line break matters: dates, addresses, salutations, closings like "Respectfully yours,", signer name and title lines, contact details. Put each line on its own line with \\n.
- "align" is "left", "center", "right" or "justify" — match the original.
- Keep the blocks in the same order as the page. One block per paragraph or group of lines.
- LEAVE OUT: letterheads, logos, seals, stamps, watermarks, handwritten signatures, handwritten initials, page numbers, and anything that is not part of the page (phone screen buttons, background objects).
- "letterhead" describes the printed letterhead band at the TOP of the page (organization name, logo, seal, address header, usually above the date). "top" and "bottom" are where that band starts and ends, as a fraction of the page height from 0 (top edge) to 1 (bottom edge). Make the band cover the whole letterhead including any line under it, but no body text. If there is no letterhead, use { "found": false, "top": 0, "bottom": 0 }.
- CHARTS AND DIAGRAMS: if the page is mainly a flowchart, decision chart, diagram, mind map or concept map (boxes joined by arrows or lines) rather than a letter or document, do NOT list the boxes one by one. Instead write it as an easy-to-follow outline in "lines" blocks: one block per box or question, its text first, then each branch on its own line as "  – LABEL → where it leads" (for example "  – YES → POLYTHEIST"). Put final results/end points in **bold**, start with the box marked "start" if there is one, and note special arrows in brackets, like "(dashed line back)". Tables inside such charts follow the TABLES rule below.
- TABLES: any part of the page set in a grid with vertical and horizontal lines (forms, rating sheets, checklists, class records, schedules) must be ONE "table" block, NOT lines of text. "rows" is a list of rows; each row is a list of cell texts from left to right, and every row has the SAME number of cells (use "" for an empty cell, and for the extra cells of a merged cell, keeping its text in the first one). Copy each cell exactly; use **bold** inside a cell where it is bold; keep checkboxes as ☐ and check marks as ✓. "header" is how many rows at the top are column headings (0 if none). Text above or below the grid (titles, directions, comments) stays in normal blocks.
- FORM BLANKS: keep fill-in lines as underscores, like "OBSERVER: ____________________", and empty boxes as ☐.
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
- NAMES NEED EXTRA CARE: people's names, titles and initials, and names of schools, places and events. Handwritten names cannot be checked against a dictionary, so only copy a name if you can clearly see EVERY letter. If any letter of a name is unclear, write [?] for that WHOLE name part (for example "[?] D. Miranda" or "Heriberto [?] D. Miranda"). Never swap in a common name that looks similar.
- NEVER ADD words that are not on the page — not titles like "Hon.", "Mr.", "Dr." or "Engr.", not missing words, not punctuation that isn't there.
- Final check before answering: look again at every name, title, date and number you wrote. If you would not bet on each letter and digit being exactly right, change it to [?].
- Keep words in Filipino or other languages exactly as written; do not translate.

Layout rules for notes:
- Titles, topics and headings: their own "lines" block, wrapped in **double asterisks**.
- Words the writer underlined, boxed, circled or highlighted as key terms: wrap them in **double asterisks** too.
- Bulleted or dashed items: one item per line, starting with "• ". Numbered or lettered items: keep the writer's own "1." "2." "a." "b.". Put a list in one "lines" block with \\n between items.
- Sub-points written further to the right: start the line with two spaces then "– ".
- Sentences that flow across lines: "paragraph" blocks, align "left".
- Formulas and equations: copy them on their own line in a "lines" block, as plain text (for example "A = πr²", "H2O", "x^2 + 3x = 10").
- LEAVE OUT: notebook ruled lines, margin lines, holes, page numbers printed on the notebook, doodles, drawings and anything that is not part of the page. A picture or doodle: put a line "[drawing]" where it is. A flowchart, decision chart, mind map or labelled diagram: write it as an outline — each box on its own line, then its branches as "  – LABEL → where it leads", with end results in **bold**.
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
  const checked = await checkCodeOrFree(code, secret, body && body.device);
  if (!checked.valid) {
    return { error: checked.reason === 'expired'
      ? 'Your Premium code has expired. Please renew to use Retype.'
      : 'Retype is a Premium feature. Your access code could not be confirmed.' };
  }

  const { limit, paid } = await pageLimitFor(checked);
  const usageStore = getStore('retype-pages');
  const usageKey = checked.owner;              // one count per payment (per purchase code)
  const used = Number(await usageStore.get(usageKey)) || 0;
  if (used >= limit) {
    return { error: limitReachedMsg(limit, paid), pagesLeft: 0 };
  }
  if (await freeDayFull(checked)) return { error: BUSY };

  const match = String(image || '').match(/^data:image\/(jpeg|png);base64,(.+)$/);
  if (!match) return { error: 'No page picture was received. Please try again.' };

  // Ask Claude with streaming, so we can stop cleanly before Netlify's
  // 60-second limit instead of being cut off with no answer at all.
  const t0 = Date.now();
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
        max_tokens: 8000,
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
  console.log('retype read done', { ms: Date.now() - t0, stop: stopReason, chars: text.length });
  if (stopReason === 'max_tokens') return { error: TOO_LONG_MSG, tooLong: true };

  let parsed = null;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
  if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
    return { error: 'Could not read any text on that page. Try a clearer photo.' };
  }

  const allowedTypes = ['paragraph', 'lines', 'table'];
  // A table block: tidy its rows (same number of cells in each), and keep a text copy for translate/grammar.
  parsed.blocks = parsed.blocks.map(b => {
    if (!b || b.type !== 'table' || !Array.isArray(b.rows)) return b;
    let rows = b.rows.filter(r => Array.isArray(r)).slice(0, 80).map(r => r.slice(0, 14).map(c => String(c == null ? '' : c).slice(0, 600)));
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows = rows.map(r => r.concat(Array(cols - r.length).fill('')));
    if (!cols || !rows.length) return null;
    return { type: 'table', header: Math.max(0, Math.min(3, parseInt(b.header, 10) || 0)), rows, text: rows.map(r => r.join(' | ')).join('\n') };
  });
  const allowedAlign = ['left', 'center', 'right', 'justify'];
  const signerIdx = Number.isInteger(parsed.signerBlock) ? parsed.signerBlock : -1;
  const kept = parsed.blocks
    .map((b, i) => ({ b, isSigner: i === signerIdx }))
    .filter(({ b }) => b && typeof b.text === 'string' && b.text.trim());
  const blocks = kept.map(({ b }) => ({
    type: allowedTypes.includes(b.type) ? b.type : 'paragraph',
    align: allowedAlign.includes(b.align) ? b.align : 'left',
    text: b.text.slice(0, 5000),
    ...(b.type === 'table' ? { rows: b.rows, header: b.header } : {})
  }));
  const signerBlock = kept.findIndex(k => k.isSigner);

  let letterhead = { found: false, top: 0, bottom: 0 };
  const lh = parsed.letterhead;
  if (!notes && lh && lh.found === true && typeof lh.top === 'number' && typeof lh.bottom === 'number') {
    const top = Math.max(0, Math.min(1, lh.top)), bottom = Math.max(0, Math.min(0.6, lh.bottom));
    if (bottom - top > 0.02) letterhead = { found: true, top, bottom };
  }

  await usageStore.set(usageKey, String(used + 1));   // count only successful pages
  await bumpFreeDay(checked);
  return { blocks, signerBlock, letterhead, pagesLeft: Math.max(0, limit - used - 1) };
}


export default async (req) => {
  const body = await req.json().catch(() => null);
  const jobId = String((body && body.jobId) || '');
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return;
  const jobs = getStore({ name: 'retype-jobs', consistency: 'strong' });
  const results = getStore({ name: 'retype-results', consistency: 'strong' });
  const job = await jobs.get(jobId, { type: 'json' });
  if (!job) return;
  let result;
  try { result = await doRetype({ code: job.code, device: job.device, image: job.image, mode: job.mode }, Date.now() + 12 * 60 * 1000); }
  catch (err) { result = { error: err.message || 'Something went wrong while retyping.' }; }
  await results.setJSON(jobId, { done: true, at: Date.now(), ...result });
  await jobs.delete(jobId);          // the photo is not kept once the page is read
};

export const config = { background: true };
