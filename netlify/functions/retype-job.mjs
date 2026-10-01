// This runs on Netlify's servers, not in the visitor's browser.
//
// Ticket desk for "Retype" on long pages:
//  { action: "start", code, image }  -> checks Premium, saves the photo, returns { jobId }
//  { action: "status", jobId }       -> { pending: true } while reading, then the result
// The actual reading happens in retype-work-background.mjs.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

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
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();

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


const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null) || {};
  const jobs = getStore({ name: 'retype-jobs', consistency: 'strong' });
  const results = getStore({ name: 'retype-results', consistency: 'strong' });

  if (body.action === 'status') {
    const jobId = String(body.jobId || '');
    if (!/^[0-9a-f-]{36}$/.test(jobId)) return json({ error: 'Unknown ticket.' });
    const r = await results.get(jobId, { type: 'json' });
    if (r) { await results.delete(jobId); return json(r); }
    return json({ pending: true });
  }

  if (body.action === 'start') {
    const secret = process.env.ACCESS_CODE_SECRET;
    if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'Retype is not set up yet: the server is missing ANTHROPIC_API_KEY as a Netlify environment variable.' });
    if (!secret) return json({ error: 'Server is missing ACCESS_CODE_SECRET as a Netlify environment variable.' });
    const checked = await checkCodeOrFree(body.code, secret, body.device);
    if (!checked.valid) {
      return json({ error: checked.reason === 'expired'
        ? 'Your Premium code has expired. Please renew to use Retype.'
        : 'Retype is a Premium feature. Your access code could not be confirmed.' });
    }
    const { limit, paid } = await pageLimitFor(checked);
    const used = Number(await getStore('retype-pages').get(checked.owner)) || 0;
    if (used >= limit) return json({ error: limitReachedMsg(limit, paid), pagesLeft: 0 });
    if (await freeDayFull(checked)) return json({ error: BUSY });
    if (!/^data:image\/(jpeg|png);base64,/.test(String(body.image || ''))) return json({ error: 'No page picture was received. Please try again.' });
    const jobId = crypto.randomUUID();
    await jobs.setJSON(jobId, { code: body.code, device: body.device, image: body.image, mode: body.mode === 'notes' ? 'notes' : 'letter', at: Date.now() });
    return json({ jobId });
  }

  return json({ error: 'Unknown request.' });
};
