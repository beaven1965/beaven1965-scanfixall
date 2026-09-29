// This runs on Netlify's servers, not in the visitor's browser.
//
// Ticket desk for "Retype" on long pages:
//  { action: "start", code, image }  -> checks Premium, saves the photo, returns { jobId }
//  { action: "status", jobId }       -> { pending: true } while reading, then the result
// The actual reading happens in retype-work-background.mjs.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const PAGE_LIMIT = { family: 100, class: 100 };
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
    if (!body.code) return json({ error: 'Retype is a Premium feature. Please unlock Premium first.' });
    const checked = await checkCode(body.code, secret);
    if (!checked.valid) {
      return json({ error: checked.reason === 'expired'
        ? 'Your Premium code has expired. Please renew to use Retype.'
        : 'Retype is a Premium feature. Your access code could not be confirmed.' });
    }
    const limit = PAGE_LIMIT[checked.plan] || 100;
    const used = Number(await getStore('retype-pages').get(checked.owner)) || 0;
    if (used >= limit) return json({ error: "You've used all " + limit + ' Retype pages for this 30-day period. You get ' + limit + ' new pages when you renew. Clean paper still works without limits.', pagesLeft: 0 });
    if (!/^data:image\/(jpeg|png);base64,/.test(String(body.image || ''))) return json({ error: 'No page picture was received. Please try again.' });
    const jobId = crypto.randomUUID();
    await jobs.setJSON(jobId, { code: body.code, image: body.image, at: Date.now() });
    return json({ jobId });
  }

  return json({ error: 'Unknown request.' });
};
