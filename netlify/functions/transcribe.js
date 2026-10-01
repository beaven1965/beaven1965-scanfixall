// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real OpenAI API key (set as an Environment Variable in Netlify)
// so it's never visible to anyone using the app.
//
// 🎙 Free load: each phone/laptop gets FREE_MINUTES of recordings turned into text, one time
// (like free cellphone load — no monthly reset, no expiry). Premium codes (SE- and family SF-) are not limited.
//   { action: 'status', device, code }                 -> { premium, minutesUsed, minutesLimit, minutesLeft }
//   { audioBase64, mimeType, device, seconds, code }   -> { transcript, minutesLeft }
// Needs OPENAI_API_KEY and ACCESS_CODE_SECRET as Netlify environment variables.

const crypto = require('node:crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const FREE_MINUTES = 60;            // ← free recording minutes per device (one-time)
const GLOBAL_DAILY_MINUTES = 300;   // ← safety cap for all FREE users together per day (protects your OpenAI bill)
const OLD_FORMAT_CUTOFF_MS = new Date('2026-09-30T00:00:00+08:00').getTime();
const dayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const reply = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

const sig6 = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 6).toUpperCase();
function same(a, b){ const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); }

// Same rules as verify-code.js: is this a working Premium (or family) code right now?
async function isPremium(code){
  const secret = process.env.ACCESS_CODE_SECRET;
  const c = String(code || '').trim().toUpperCase();
  if (!secret || !c) return false;
  let m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{8})-([0-9A-F]{6})$/);
  if (m) return same(sig6(secret, m[1] + m[2]), m[3]) && Date.now() < parseInt(m[2], 16) * 1000;
  m = c.match(/^SE-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) return same(sig6(secret, m[1]), m[2]) && Date.now() < OLD_FORMAT_CUTOFF_MS;
  m = c.match(/^SF-([0-9A-F]{10})-([0-9A-F]{6})$/);
  if (m) {
    if (!same(sig6(secret, m[1]), m[2])) return false;
    const rec = await getStore('family-codes').get(c, { type: 'json' });
    if (!rec || rec.revoked === true) return false;
    const om = String(rec.ownerCode || '').match(/^SE-[0-9A-F]{10}-([0-9A-F]{8})-[0-9A-F]{6}$/);
    return Date.now() < (om ? parseInt(om[1], 16) * 1000 : OLD_FORMAT_CUTOFF_MS);
  }
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  try {
    connectLambda(event);
    const body = JSON.parse(event.body || '{}');
    const { audioBase64, mimeType, device, seconds, code } = body;
    const premium = await isPremium(code);
    const usage = getStore('free-usage');
    const mKey = 'min:' + device + ':starter';
    const gKey = 'global-min:' + dayKey();

    if (body.action === 'status') {
      if (premium) return reply(200, { premium: true });
      if (!validDevice(device)) return reply(200, { error: 'Please refresh the app.' });
      const usedSec = Number(await usage.get(mKey)) || 0;
      return reply(200, { premium: false, minutesUsed: Math.ceil(usedSec / 60), minutesLimit: FREE_MINUTES, minutesLeft: Math.max(0, Math.floor((FREE_MINUTES * 60 - usedSec) / 60)) });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return reply(500, { error: 'Server is not configured with an OpenAI API key yet.' });
    if (!audioBase64) return reply(400, { error: 'No audio provided' });

    let pieceSec = 0;
    if (!premium) {
      if (!validDevice(device)) return reply(400, { error: 'Please refresh the app and try again.' });
      const usedSec = Number(await usage.get(mKey)) || 0;
      const globalSec = Number(await usage.get(gKey)) || 0;
      if (usedSec >= FREE_MINUTES * 60) {
        return reply(429, { error: "You've used your " + FREE_MINUTES + ' free recording minutes. Your recording is still saved in your Library. Get Premium (Settings → Premium) to keep turning recordings into text.', limit: true });
      }
      if (globalSec >= GLOBAL_DAILY_MINUTES * 60) {
        return reply(429, { error: 'The app is very busy today. Your recording is saved in your Library — please try again tomorrow.', limit: true });
      }
      const bytes = Math.floor(audioBase64.length * 3 / 4);
      pieceSec = Math.min(150, Math.max(Number(seconds) || 0, bytes / 32000));   // never less than the audio size allows
    }

    const binary = Buffer.from(audioBase64, 'base64');
    const ext = (mimeType && mimeType.includes('wav')) ? 'wav' : 'webm';
    const blob = new Blob([binary], { type: mimeType || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, 'recording.' + ext);
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');
    formData.append('temperature', '0');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: formData
    });

    if (!res.ok) {
      const errText = await res.text();
      return reply(502, { error: 'Transcription failed (' + res.status + ').', detail: errText });
    }

    const data = await res.json();
    if (premium) return reply(200, { transcript: data.text, premium: true });

    const nowUsed = (Number(await usage.get(mKey)) || 0) + Math.round(pieceSec);
    await usage.set(mKey, String(nowUsed));
    await usage.set(gKey, String((Number(await usage.get(gKey)) || 0) + Math.round(pieceSec)));
    return reply(200, { transcript: data.text, minutesLeft: Math.max(0, Math.floor((FREE_MINUTES * 60 - nowUsed) / 60)) });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
