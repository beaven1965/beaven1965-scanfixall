// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real Anthropic API key (set as an Environment Variable in Netlify)
// so it's never visible to anyone using the app.
//
// Translates a sermon's takeaway, highlight bullets, and full transcript
// into another language, keeping the same structure so the app can just
// swap the displayed text.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an Anthropic API key yet.' }) };
    }

    const { transcript, takeaway, bullets, targetLanguage } = JSON.parse(event.body || '{}');
    if (!transcript || !targetLanguage) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing transcript or targetLanguage.' }) };
    }

    // For languages the model tends to flatten into Tagalog, anchor it with
    // real worked examples so it has concrete vocabulary/grammar to imitate
    // instead of just a description of "don't do X".
    const regionalExemplars = {
      'cebuano (bisaya)': `Worked examples of genuine Cebuano (Bisaya) — study the vocabulary and sentence patterns, they are NOT Tagalog:
- "She denied any connection between the two investigations." → "Gilalis niya ang bisan unsang koneksyon tali sa duha ka imbestigasyon."
- "He said his office works independently of his wife's role." → "Miingon siya nga ang iyang opisina naglihok nga independente sa tahas sa iyang asawa."
- "She promised full cooperation with local investigations." → "Misaad siya og bug-os nga kooperasyon sa lokal nga mga imbestigasyon."
- "This is the day the Lord has made." → "Kini ang adlaw nga gibuhat sa Ginoo."
Notice: "tali sa" (between/among) not "sa pagitan ng"; "og"/"ug" (and) not "at"; "niya/siya" placement and verb-first sentence order; "mga" for plurals like Tagalog but very different verbs and connectors ("nga" not "na/ng" in most places).`,
      'ilocano': `Worked examples of genuine Ilocano — study the vocabulary and sentence patterns, they are NOT Tagalog:
- "She denied any connection between the two investigations." → "Inlibakna ti aniaman a koneksion iti nagbaetan ti dua nga imbestigasion."
- "He said his office works independently of his wife's role." → "Kinunana a ti opisinana ket agtrabaho a sibubukel manipud iti akem ti asawana."
- "She promised full cooperation with local investigations." → "Nangipatulod isuna iti naan-anay a kooperasion kadagiti lokal nga imbestigasion."
- "This is the day the Lord has made." → "Daytoy ti aldaw nga inaramid ti Apo."
Notice: "iti nagbaetan" (between/among) not "sa pagitan ng"; "ken" (and) not "at"; "ti/iti" articles instead of "ang/ng/sa"; "kinunana", "nangipatulod" verb forms instead of Tagalog "sinabi niya", "nangako siya".`
    };
    const langKey = String(targetLanguage || '').trim().toLowerCase();
    const exemplarBlock = regionalExemplars[langKey] ? '\n\n' + regionalExemplars[langKey] : '';

    const systemPrompt = `You translate a sermon/talk's takeaway, highlight bullets, and full transcript into ${targetLanguage}.
Translate naturally and faithfully — capture the real meaning and tone, not a word-for-word translation. Keep it warm and easy to read aloud, the way a fluent native speaker would say it. Keep names of people, places, and Bible book names in their standard form for ${targetLanguage} (e.g. use the conventional localized name for Bible books/figures if one commonly exists in that language).

If ${targetLanguage} is Cebuano (Bisaya), Ilocano, or another regional Philippine language: write in that language's own actual vocabulary and grammar, NOT in Tagalog/Filipino with a few words swapped. These are genuinely distinct languages, not dialects of Tagalog — a Cebuano or Ilocano speaker should recognize the output as their own language, not as Tagalog.${exemplarBlock}

Before you finalize your answer, silently re-read your own "transcript" translation and check: does this actually look like ${targetLanguage}, or did it slip into Tagalog/Filipino with just a word or two changed? If it reads like Tagalog, rewrite it properly in ${targetLanguage} before responding — do not settle for a Tagalog draft.

Respond with ONLY valid JSON, no other text, no markdown fences, in this exact shape:
{"takeaway": "...", "bullets": ["...", "..."], "transcript": "..."}

- "takeaway": the translated takeaway, same number of sentences and same meaning as the original.
- "bullets": the translated bullets, same count and order as the original.
- "transcript": the full transcript translated into ${targetLanguage}, preserving paragraph/sentence flow.

IMPORTANT: Your entire reply must be that one JSON object and nothing else — no preamble, no note about ${targetLanguage} being a regional or lower-resource language, no apology, no explanation before or after. Even if you are less certain about some regional terms in ${targetLanguage}, still do your best full translation rather than commenting on the difficulty or refusing. Your reply must start with { and end with }.`;

    const userContent =
      'Takeaway:\n' + (takeaway || '') +
      '\n\nBullets:\n' + (Array.isArray(bullets) ? bullets.map((b) => '- ' + b).join('\n') : '') +
      '\n\nTranscript:\n' + transcript;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userContent }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Translation failed (' + res.status + ').', detail: errText })
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
      if (!parsed.transcript) throw new Error('missing fields');
      if (!Array.isArray(parsed.bullets)) parsed.bullets = [];
      if (!parsed.takeaway) parsed.takeaway = '';
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Received an unexpected response while translating. Please try again.' })
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
