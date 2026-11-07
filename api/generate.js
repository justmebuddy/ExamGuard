// api/generate.js — Vercel serverless function. Keeps AI keys off the browser.
//
// Set these in Vercel → Project → Settings → Environment Variables (at least one key):
//   GROQ_API_KEY     free key from console.groq.com        (tried first: very fast)
//   GEMINI_API_KEY   free key from aistudio.google.com     (used if Groq fails or is rate-limited)
// Optional overrides: GROQ_MODEL (default openai/gpt-oss-120b), GEMINI_MODEL (default gemini-2.5-flash)

const SUBJECTS = ['EVS', 'Mathematics', 'Physics', 'Chemistry', 'Technical'];
const MAX_QUESTION_CHARS = 4000;
const ANSWER_WORDS = 400;

function buildPrompt(subject) {
  return `You are an elite JC Bose University of Science & Technology (YMCA), Faridabad examination answer writer and academic mentor operating in RANK HOLDER MODE.

Your task is to write a complete, detailed, university-grade answer for B.Tech students. Use formal engineering terminology. Target approximately ${ANSWER_WORDS} words for the main answer in formal tone.

CRITICAL RULES:
1. Wrap ALL important technical terms and keywords in <<TERM>> format (e.g., <<Photosynthesis>>, <<Newton's Law>>, <<Algorithm>>)
2. Always include a detailed ASCII box diagram with labels, arrows, and clear structure
3. Provide exactly 5 numbered key points
4. Provide 3 predicted repeated questions based on JC Bose UST exam patterns
5. Structure your entire response as a single valid JSON object — no markdown, no backticks
6. For numerical or derivation questions, show every step with formulas and units, and double-check the arithmetic before stating the final answer

SUBJECT: ${subject}

OUTPUT FORMAT (strict JSON only):
{
  "question": "the question restated",
  "introduction": "2-3 sentence formal introduction with <<keywords>>",
  "mainAnswer": "detailed answer paragraph(s) with <<keywords>> wrapped, ${ANSWER_WORDS} words approx",
  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "diagram": "ASCII diagram with boxes, arrows, labels — use |, -, +, >, <, ^ characters",
  "diagramTitle": "Fig: Title of Diagram",
  "finalAnswer": "one concise boxed final answer sentence",
  "conclusion": "2-3 sentence conclusion with exam significance",
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "predictedQ1": "Predicted question 1",
  "pq1fw": "Framework: Define → Explain → Example → Diagram → Conclude",
  "predictedQ2": "Predicted question 2",
  "pq2fw": "Framework: ...",
  "predictedQ3": "Predicted question 3",
  "pq3fw": "Framework: ..."
}`;
}

function providers() {
  const list = [];
  if (process.env.GROQ_API_KEY) {
    list.push({
      name: 'groq',
      base: 'https://api.groq.com/openai/v1',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    });
  }
  if (process.env.GEMINI_API_KEY) {
    list.push({
      name: 'gemini',
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    });
  }
  return list;
}

async function post(p, body) {
  return fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
}

async function callProvider(p, system, question) {
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    max_tokens: 3000,
    temperature: 0.5,
  };
  // Low reasoning effort keeps gpt-oss fast; if the provider rejects the field, retry without it.
  const useEffort = /gpt-oss/.test(p.model);
  if (useEffort) body.reasoning_effort = 'low';

  let res = await post(p, body);
  if (res.status === 400 && useEffort) {
    delete body.reasoning_effort;
    res = await post(p, body);
  }
  if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`);

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error(`${p.name} returned an empty answer`);
  return content;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const question = String(body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
  const subject = SUBJECTS.includes(body.subject) ? body.subject : 'Technical';
  if (!question) return res.status(400).json({ error: 'Question is required' });

  const list = providers();
  if (!list.length) {
    return res.status(500).json({ error: 'Server is not configured: set GROQ_API_KEY or GEMINI_API_KEY' });
  }

  const system = buildPrompt(subject);
  const errors = [];
  for (const p of list) {
    try {
      const content = await callProvider(p, system, question);
      return res.status(200).json({ content, model: p.model });
    } catch (e) {
      errors.push(e.message);
    }
  }
  console.error('All AI providers failed:', errors.join(' | '));
  return res.status(502).json({ error: `All AI providers failed (${errors.join('; ')})` });
};
