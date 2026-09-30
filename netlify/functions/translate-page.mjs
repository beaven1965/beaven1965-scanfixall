// This runs on Netlify's servers, not in the visitor's browser.
//
// "Translate" (Premium) — translates a page that was already retyped.
// Uses 1 Retype page from the same 100-page allowance (only when it works).
// The app keeps the original, so the person can switch back any time.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-5';     // better with Philippine languages than the small model
const PAGE_LIMIT = { family: 100, class: 100 };   // pages per 30-day PAID code
const FREE_PAGE_LIMIT = 10;                         // free (promo) codes: 10 pages in total

// Paid codes are marked in the 'paid-codes' store by verify-payment when PayMongo
// confirms the payment. Any other code is a free promo code. The owner can also
// list codes (comma-separated) in the PAID_CODES environment variable.
async function pageLimitFor(checked){
  const owner = checked.owner;
  const extra = String(process.env.PAID_CODES || '').toUpperCase().split(',').map(t => t.trim()).filter(Boolean);
  const paid = extra.includes(owner) || !!(await getStore('paid-codes').get(owner));
  return { paid, limit: paid ? (PAGE_LIMIT[checked.plan] || 100) : FREE_PAGE_LIMIT };
}
function limitReachedMsg(limit, paid){
  return paid
    ? limitReachedMsg(limit, paid)
    : "You've used your " + limit + ' free Retype/Translate pages. Get Premium (₱250 a month) for 100 pages every month. Scanning, Clean paper, Shrink and Sign stay free.';
}
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

// The app's page builder handles Chinese/Japanese (no spaces) and Arabic (right to left) too.
const LANGUAGES = {
  en: 'English', fil: 'Filipino (Tagalog)', ceb: 'Cebuano (Bisaya)', ilo: 'Ilocano',
  hil: 'Hiligaynon (Ilonggo)', bik: 'Bikol', war: 'Waray', pam: 'Kapampangan', pag: 'Pangasinan',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', id: 'Indonesian',
  ms: 'Malay', vi: 'Vietnamese',
  ja: 'Japanese', zh: 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', ko: 'Korean', ar: 'Arabic', hi: 'Hindi'
};

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



function instructions(lang){
  return `Translate the numbered blocks below into ${lang}. They are a retyped letter, document or set of class notes.

Rules:
- Translate the meaning naturally, the way a careful native ${lang} speaker would write it. For Philippine languages, use real everyday ${lang} words, not Tagalog words with ${lang} spelling.
- Keep EXACTLY as they are: names of people, places, schools, hospitals and organizations; numbers, dates, amounts, times, phone and ID numbers; formulas; abbreviations like "CESO V", "MD", "DepEd"; and every [?] mark.
- Keep the same line breaks inside each block, the same bullets ("• ", "1.", "a.") and keep **double asterisks** around the same words (translated).
- If a block is already in ${lang}, return it unchanged.
- Return ONLY a JSON object, no other text: { "blocks": ["translated block 0", "translated block 1", ...] } with exactly the same number of blocks, in the same order.`;
}

async function doTranslate(body, deadline){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const secret = process.env.ACCESS_CODE_SECRET;
  if (!apiKey || !secret) return { error: 'Translate is not set up on the server yet.' };

  const { code, blocks, lang } = body || {};
  const langName = LANGUAGES[lang];
  if (!langName) return { error: 'Please choose a language.' };
  const checked = await checkCode(code, secret);
  if (!checked.valid) {
    return { error: checked.reason === 'expired'
      ? 'Your Premium code has expired. Please renew to use Translate.'
      : 'Translate is a Premium feature. Your access code could not be confirmed.' };
  }
  if (!Array.isArray(blocks) || !blocks.length) return { error: 'There is no text on the page to translate.' };
  const texts = blocks.slice(0, 80).map(t => String(t || '').slice(0, 5000));

  const { limit, paid } = await pageLimitFor(checked);
  const usageStore = getStore('retype-pages');
  const used = Number(await usageStore.get(checked.owner)) || 0;
  if (used >= limit) return { error: limitReachedMsg(limit, paid), pagesLeft: 0 };

  const numbered = texts.map((t, i) => 'Block ' + i + ':\n' + t).join('\n\n');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(5000, deadline - Date.now()));
  let text = '', stop = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content: instructions(langName) + '\n\n' + numbered }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { clearTimeout(timer); return { error: 'The translating service had a problem (' + res.status + '). Please try again in a moment.' }; }
    text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    stop = data.stop_reason || '';
  } catch (err) {
    clearTimeout(timer);
    if (abort.signal.aborted) return { error: 'This page is too long to translate in one go. Please try a shorter page.' };
    throw err;
  }
  clearTimeout(timer);
  if (stop === 'max_tokens') return { error: 'This page is too long to translate in one go. Please try a shorter page.' };

  let parsed = null;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
  if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length !== texts.length || !parsed.blocks.every(b => typeof b === 'string')) {
    return { error: 'Could not translate right now. Please try again.' };
  }
  await usageStore.set(checked.owner, String(used + 1));     // count only a finished translation
  return { blocks: parsed.blocks.map(b => b.slice(0, 6000)), language: langName, pagesLeft: Math.max(0, limit - used - 1) };
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
      try { result = await doTranslate(body, started + 52000); }
      catch (err) { result = { error: err.message || 'Something went wrong while translating.' }; }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify(result)));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};
