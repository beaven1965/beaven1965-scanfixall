// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real Anthropic API key (set as an Environment Variable in Netlify)
// so it's never visible to anyone using the app.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an Anthropic API key yet.' }) };
    }

    const { transcript } = JSON.parse(event.body || '{}');
    if (!transcript) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No transcript provided' }) };
    }

    const systemPrompt = `You turn raw transcripts of spoken audio (sermons, lectures, meetings, or similar talks) into a short, shareable takeaway and a set of highlight bullets.
The transcript may be imperfect: spoken language, filler words, or transcription errors. Read past the noise to the intent.
First, quietly notice what kind of talk this is (sermon, lecture, meeting, class, etc.) and match your tone and content to it — don't force religious or academic framing onto content that isn't that.

Respond with ONLY valid JSON, no other text, no markdown fences, in this exact shape:
{"takeaway": "...", "bullets": ["...", "...", "..."]}

For "takeaway": exactly 3 sentences someone could read in 10 seconds and want to share.
- Sentence 1: the core point or theme of the talk, in plain, warm language.
- Sentence 2: one vivid detail, example, story, or specific reference from the talk that makes it memorable.
- Sentence 3: a practical, forward-looking takeaway — a next step, decision, or thing to remember or apply.
Avoid jargon and generic summarizing. Tone: warm and conversational, like a friend texting you the one thing that stuck with them.

For "bullets": 4-6 short highlight bullets in the order the talk unfolded (the main point, key examples or details, any decisions or action items). Plain language, one short sentence each. If the talk includes action items, assignments, or decisions (common in meetings), list those explicitly. Last bullet is the practical "so what" — what to do or remember from this.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Transcript:\n\n' + transcript }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Summarization failed (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    let cleaned = raw.replace(/```json|```/g, '').trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
      if (!parsed.takeaway || !Array.isArray(parsed.bullets)) {
        throw new Error('missing fields');
      }
    } catch (e) {
      const wordCount = transcript.trim().split(/\s+/).length;
      if (wordCount < 15) {
        return {
          statusCode: 422,
          body: JSON.stringify({ error: 'The recording was too short to summarize. Please record more and try again.' })
        };
      }
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Received an unexpected response while preparing the takeaway. Please try again.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
