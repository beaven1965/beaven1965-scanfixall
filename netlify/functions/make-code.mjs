// This runs on Netlify's servers, not in the visitor's browser.
//
// 🔑 ScanFixAll Code Maker (owner only). Makes an access code without a payment —
// for yourself, testers, students you sponsor, or someone whose payment didn't go through.
// Protected by ADMIN_PASSWORD (a Netlify environment variable only you know).
//   { password, action: 'make', days, note, plan } -> { code, expiresAt, plan }
//      plan: 'free'   = trial code: 3 AI pages in total (Retype/Translate/Listen), one time
//            'family' = like a paid Family code: 60 AI pages, up to 5 family codes
//            'class'  = like a paid Class code: 100 AI pages, up to 50 student codes
//   { password, action: 'list' }             -> { codes: [...] }   (last 50 made)
// Codes have their expiry built in, like paid codes.
// Also used by the 'Code Maker' file on Beaven's laptop (one file for all his apps).

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

// CORS: lets the Code Maker file on your laptop call this (it is still protected by ADMIN_PASSWORD).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
function same(a, b){ const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const admin = process.env.ADMIN_PASSWORD;
  const secret = process.env.ACCESS_CODE_SECRET;
  if (!admin || admin.length < 8) return json({ error: 'Add ADMIN_PASSWORD (at least 8 characters) in Netlify → Environment variables, then redeploy.' });
  if (!secret) return json({ error: 'ACCESS_CODE_SECRET is missing in Netlify → Environment variables.' });

  const body = await req.json().catch(() => null) || {};
  if (!same(String(body.password || ''), admin)) {
    await new Promise(r => setTimeout(r, 1500));          // slows down guessing
    return json({ error: 'Wrong password.' });
  }
  const log = getStore('admin-codes');

  if (body.action === 'list') {
    const list = (await log.get('list', { type: 'json' })) || [];
    return json({ codes: list.slice(-50).reverse() });
  }

  const days = Math.max(1, Math.min(366, parseInt(body.days, 10) || 30));
  const note = String(body.note || '').trim().slice(0, 80);
  const plan = ['free', 'family', 'class'].includes(body.plan) ? body.plan : 'family';
  const randomPart = crypto.randomBytes(5).toString('hex').toUpperCase();
  const expiresAtMs = Date.now() + days * 24 * 60 * 60 * 1000;
  const expiryHex = Math.floor(expiresAtMs / 1000).toString(16).toUpperCase().padStart(8, '0');
  const isClass = plan === 'class';
  const signature = crypto.createHmac('sha256', secret).update((isClass ? 'CLASS' : '') + randomPart + expiryHex).digest('hex').slice(0, 6).toUpperCase();
  const code = (isClass ? 'SC-' : 'SE-') + randomPart + '-' + expiryHex + '-' + signature;
  // Family and Class codes count as paid (60 / 100 AI pages). Free codes get the 3 trial AI pages.
  if (plan !== 'free') await getStore('paid-codes').set(code, JSON.stringify({ plan, paidAt: new Date().toISOString(), madeBy: 'code-maker' }));
  const expiresAt = new Date(expiresAtMs).toISOString();

  const list = (await log.get('list', { type: 'json' })) || [];
  list.push({ code, note: (plan === 'free' ? 'Free · ' : plan === 'class' ? 'Class · ' : 'Family · ') + note, days, plan, expiresAt, madeAt: new Date().toISOString() });
  await log.setJSON('list', list.slice(-200));
  return json({ code, expiresAt, plan });
};
