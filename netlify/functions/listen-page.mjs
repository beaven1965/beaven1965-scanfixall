// This runs on Netlify's servers, not in the visitor's browser.
//
// "🔊 Listen" (Premium) — reads the retyped (or translated) page aloud with
// OpenAI's AI voice, which sounds clear in Tagalog and other languages on any
// phone or laptop. Uses 1 AI page from the same monthly allowance as Retype
// and Translate (counted only once the first part of the voice is ready).
// Needs OPENAI_API_KEY as a Netlify environment variable.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const PAGE_LIMIT = { family: 60, class: 100 };    // AI pages per 30-day PAID code (Family ₱250 / Class ₱1,500)
const FREE_PAGE_LIMIT = 3;                          // free (trial) codes: 3 AI pages in total

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
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

// The app's page builder handles Chinese/Japanese (no spaces) and Arabic (right to left) too.
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




const MAX_CHARS = 8000;          // about one full, crowded page
const PIECE = 3800;              // the voice service takes up to 4096 characters at a time

function pieces(text){
  const out = []; let cur = '';
  (text.match(/[^.!?。！？\n]+[.!?。！？\n]*\s*/g) || [text]).forEach(s => {
    if((cur + s).length > PIECE && cur){ out.push(cur); cur = ''; }
    while(s.length > PIECE){ out.push(s.slice(0, PIECE)); s = s.slice(PIECE); }
    cur += s;
  });
  if(cur.trim()) out.push(cur);
  return out;
}
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const openaiKey = process.env.OPENAI_API_KEY;
  const secret = process.env.ACCESS_CODE_SECRET;
  if (!openaiKey) return json({ error: 'Listen is not set up yet: the server is missing OPENAI_API_KEY as a Netlify environment variable.' });
  if (!secret) return json({ error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' });

  const body = await req.json().catch(() => null) || {};
  const checked = await checkCode(body.code, secret);
  if (!checked.valid) {
    return json({ error: checked.reason === 'expired'
      ? 'Your Premium code has expired. Please renew to use Listen.'
      : 'Listen is a Premium feature. Your access code could not be confirmed.' });
  }
  const text = String(body.text || '').replace(/\[\?\]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return json({ error: 'There is no text on the page to read.' });

  const { limit, paid } = await pageLimitFor(checked);
  const usageStore = getStore('retype-pages');
  const used = Number(await usageStore.get(checked.owner)) || 0;
  if (used >= limit) return json({ error: limitReachedMsg(limit, paid), pagesLeft: 0 });

  const parts = pieces(text);
  const stream = new ReadableStream({
    async start(controller){
      let counted = false;
      for (const part of parts) {
        let res;
        try {
          res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey },
            body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: part, response_format: 'mp3' })
          });
        } catch (e) { break; }
        if (!res.ok) { console.log('listen: voice service error', res.status); break; }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!counted) { counted = true; await usageStore.set(checked.owner, String(used + 1)); }
        controller.enqueue(buf);
      }
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Pages-Left': String(Math.max(0, limit - used - 1)) } });
};
