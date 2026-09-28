// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real Anthropic API key (set as an Environment Variable
// in Netlify) so it's never visible to anyone using the app.
//
// Generates a full DepEd-style Daily Lesson Log (DLL) for any Senior
// High School subject, grade level, and topic. Built for the OLD
// (pre-Strengthened SHS) curriculum format that's still in use for
// Grade 12 this school year — the same structure works for any
// subject (UCSP, Philosophy, General Biology, Entrepreneurship, etc.)
// so one teacher can use it across their whole load, and other
// teachers at the school can use it for their own subjects too.
//
// NOTE for future updates: once DepEd Santa Rosa City / the Strengthened
// SHS Program publishes an official new-format template (e.g. an
// "ILAW"-style Intentions/Learning Experiences/Assessment/Ways Forward
// layout) for the incoming Grade 11 subjects, this prompt and the
// JSON contract below are the only things that need updating — the
// frontend rendering already works section-by-section and can be
// extended without a rewrite.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an Anthropic API key yet.' }) };
    }

    const { subject, gradeLevel, duration, topic } = JSON.parse(event.body || '{}');
    if (!subject || !topic) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please provide both a subject and a topic.' }) };
    }

    const systemPrompt = `You are an experienced Filipino Senior High School teacher-trainer, writing a Daily Lesson Log (DLL) for a fellow SHS teacher in the Philippines, following DepEd's standard Daily Lesson Log format (the format used nationwide since DepEd Order No. 42, s. 2016, still in force for the old/pre-Strengthened SHS curriculum).

Write a complete, ready-to-teach lesson plan for:
- Subject: ${subject}
- Grade level: ${gradeLevel || 'Grade 12'}
- Class length: ${duration || '50 minutes'}
- Topic: ${topic}

Keep it realistic for a single class period of the stated length — don't cram in more than a teacher could actually cover. Write in clear, plain English a busy teacher can use directly, with concrete examples, sample questions, and specific activities (not vague placeholders like "discuss the topic"). Where useful, root examples in the Philippine context.

Respond with ONLY valid JSON, no markdown fences, no extra text, in this exact shape:
{
  "contentStandard": "...",
  "performanceStandard": "...",
  "learningCompetency": "... (include a DepEd-style competency code if a plausible one exists, e.g. 'HUMSS_DIASS12-...')",
  "objectives": ["knowledge objective...", "skill objective...", "attitude/values objective..."],
  "subjectMatter": "...",
  "resources": ["...", "..."],
  "procedures": {
    "reviewing": "short recall/review activity tied to the previous lesson",
    "motivation": "an engaging hook or motivational activity for this specific topic",
    "presentation": "how the teacher introduces the new material, with a concrete example",
    "discussion": "the main concept discussion/lecture content, written so the teacher could read from it",
    "developingMastery": "a guided practice activity, e.g. think-pair-share, group task, or worksheet, described concretely",
    "application": "an activity connecting the topic to students' real lives or current events",
    "generalization": "1-2 guide questions to help students state the lesson's key insight in their own words",
    "evaluation": "a short formative assessment (e.g. 5 questions or a short task) with the actual questions written out",
    "assignment": "a short, specific assignment or follow-up task for the next meeting"
  },
  "remarks": "one short line a teacher could jot after teaching (e.g. 'No. of learners who require additional activities: ___')"
}

IMPORTANT: Your entire reply must be that one JSON object and nothing else. Your reply must start with { and end with }.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Please write the lesson plan now.' }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not reach the lesson plan service (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    const raw = (data.content || []).map((b) => b.text || '').join('').trim();
    let cleaned = raw.replace(/```json|```/g, '').trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Received an unexpected response while writing the lesson plan. Please try again.' })
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
