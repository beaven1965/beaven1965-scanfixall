// This runs on Netlify's servers, not in the visitor's browser.
//
// "Suggest grammar fixes" (Premium, optional) — for a page that was already
// retyped. It only SUGGESTS: the person accepts or skips each one in the app.
// Nothing on the page changes by itself. Names, places, numbers and dates
// are never touched. Does not use up Retype pages.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MODEL = 'claude-haiku-4-5-20251001';
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

const INSTRUCTIONS = `You are proofreading a retyped letter or document. The text is given as numbered blocks.

Suggest fixes ONLY for clear mistakes in spelling, grammar, capitalization or punctuation. Be conservative: if the original is acceptable, leave it alone. Do not rewrite for style, do not make it more formal, and do not change the meaning.

NEVER change: names of people, places, schools, hospitals or organizations; numbers, dates, amounts, times, phone or ID numbers; anything marked [?]; titles and abbreviations like "CESO V", "MD", "DepEd", "Sta.", "pls."; words in Filipino or other languages.

Return ONLY a JSON object, no other text:
{ "fixes": [ { "block": 3, "from": "exact wrong words", "to": "corrected words", "why": "spelling" } ] }

- "block" is the block number shown.
- "from" must be copied EXACTLY from that block (same letters, spaces and punctuation), and should be short: just the wrong word or the few words around it.
- "why" is 1 to 4 plain words, like "spelling", "missing comma", "verb tense", "capital letter".
- If there is nothing to fix, return { "fixes": [] }.`;

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


async function doCheck(body, deadline){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const secret = process.env.ACCESS_CODE_SECRET;
  if (!apiKey || !secret) return { error: 'Grammar check is not set up on the server yet.' };

  const { code, blocks } = body || {};
  const checked = await checkCode(code, secret);
  if (!checked.valid) {
    return { error: checked.reason === 'expired'
      ? 'Your Premium code has expired. Please renew to use grammar suggestions.'
      : 'Grammar suggestions are a Premium feature. Your access code could not be confirmed.' };
  }
  if (!Array.isArray(blocks) || !blocks.length) return { error: 'There is no text on the page to check.' };
  const texts = blocks.slice(0, 80).map(t => String(t || '').slice(0, 5000));
  const numbered = texts.map((t, i) => 'Block ' + i + ':\n' + t).join('\n\n');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(5000, deadline - Date.now()));
  let text = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        messages: [{ role: 'user', content: INSTRUCTIONS + '\n\n' + numbered }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { clearTimeout(timer); return { error: 'The checking service had a problem (' + res.status + '). Please try again in a moment.' }; }
    text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
  } catch (err) {
    clearTimeout(timer);
    if (abort.signal.aborted) return { error: 'Checking took too long. Please try again.' };
    throw err;
  }
  clearTimeout(timer);

  let parsed = null;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
  if (!parsed || !Array.isArray(parsed.fixes)) return { error: 'Could not check the grammar right now. Please try again.' };

  // Keep only suggestions that really point at text on the page and change something.
  const fixes = parsed.fixes.filter(f => f && Number.isInteger(f.block) && f.block >= 0 && f.block < texts.length
      && typeof f.from === 'string' && typeof f.to === 'string' && f.from && f.from !== f.to
      && texts[f.block].includes(f.from) && !f.from.includes('[?]'))
    .slice(0, 40)
    .map(f => ({ block: f.block, from: f.from, to: f.to, why: String(f.why || '').slice(0, 40) }));
  return { fixes };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller){
      const started = Date.now();
      controller.enqueue(enc.encode(' '));
      const keepAlive = setInterval(() => controller.enqueue(enc.encode(' ')), 3000);
      let result;
      try { result = await doCheck(body, started + 52000); }
      catch (err) { result = { error: err.message || 'Something went wrong while checking.' }; }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify(result)));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};
