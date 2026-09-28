// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real OpenAI API key (set as an Environment Variable in Netlify)
// so it's never visible to anyone using the app.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an OpenAI API key yet.' }) };
    }

    const { audioBase64, mimeType } = JSON.parse(event.body || '{}');
    if (!audioBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No audio provided' }) };
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
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Transcription failed (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: data.text })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
