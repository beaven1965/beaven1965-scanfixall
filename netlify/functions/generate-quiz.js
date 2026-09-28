// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real Anthropic API key (set as an Environment Variable
// in Netlify) so it's never visible to anyone using the app.
//
// Given a sermon/lecture transcript, generates a study quiz: a mix of
// multiple-choice and short-answer questions with an answer key, meant
// for a teacher/pastor to print and hand out to students.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an Anthropic API key yet.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const transcript = (body.transcript || '').trim();
    const takeaway = (body.takeaway || '').trim();
    const title = (body.title || '').trim();

    if (!transcript) {
      return { statusCode: 400, body: JSON.stringify({ error: 'There is no transcript to build a quiz from.' }) };
    }

    // Guard against extremely long transcripts blowing the request budget —
    // the quiz only needs the substance, not every word.
    const trimmedTranscript = transcript.length > 12000 ? transcript.slice(0, 12000) + ' …' : transcript;

    const systemPrompt = `You are a careful teacher's assistant for a tool called Sermon Recorder, which is used for both church sermons and general lectures/meetings. Given a transcript, write a short comprehension quiz suitable for a teacher or pastor to hand out to students afterward. Respond with ONLY a JSON object (no markdown, no code fences, no extra text) in this exact shape:
{
  "questions": [
    {
      "type": "multiple_choice",
      "question": "the question text",
      "options": ["option A text", "option B text", "option C text", "option D text"],
      "answer": "the exact text of the correct option, copied verbatim from options"
    },
    {
      "type": "short_answer",
      "question": "the question text",
      "answer": "a brief model answer (1-2 sentences) covering the key point a correct response should include"
    }
  ]
}
Write 6 to 8 questions total, roughly half multiple_choice and half short_answer, mixed in whatever order reads naturally. Base every question strictly on the content of the transcript — do not invent facts or ask about anything not actually covered. Keep questions clear and at a level a general adult audience (not Biblical scholars or subject-matter experts) could answer after listening attentively. Keep each question and answer concise.`;

    const userContent = (title ? 'Title: ' + title + '\n\n' : '') +
      (takeaway ? 'Main takeaway: ' + takeaway + '\n\n' : '') +
      'Transcript:\n' + trimmedTranscript;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach the quiz service (' + res.status + ').', detail: errText }) };
    }

    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Received an unexpected response. Please try again.' }) };
    }

    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Received an unexpected response. Please try again.' }) };
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
