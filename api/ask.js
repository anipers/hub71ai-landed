// Vercel serverless function: grounded answer via OpenAI.
// Key lives only in the Vercel project env (OPENAI_API_KEY). Never commit it.
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const SYSTEM = `You are Landed, a relocation assistant for people moving to Abu Dhabi (ADGM / Hub71 ecosystem).
You may ONLY use the verified cards provided. Do not add facts, numbers, fees or deadlines that are not in the chosen card.
Steps:
1. Detect the language of the question (any language).
2. Pick the single card whose content answers the question. If none answers it, card = null.
3. Write a reply of 2-3 short sentences in the SAME language as the question, using only that card. Address the person directly.
4. If card is null, say in the question's language that there is no verified answer yet and suggest asking the official source; do not guess.
Return strict JSON: {"card": <id or null>, "lang": "<ISO 639-1>", "langName": "<language name in English>", "title": "<card title translated to the question language>", "answer": "<reply>"}`;

async function callOpenAI(body, attempt = 0) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 2) {
    await new Promise((res) => setTimeout(res, 400 * 2 ** attempt)); // retry with backoff
    return callOpenAI(body, attempt + 1);
  }
  return r;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY not set" });
  const { q, cards, persona } = req.body || {};
  if (typeof q !== "string" || !q.trim() || q.length > 500) return res.status(400).json({ error: "bad question" });
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 120) return res.status(400).json({ error: "bad cards" });

  const ctx = cards
    .map((c) => `[${Number(c.id)}] ${String(c.t).slice(0, 160)} :: ${String(c.a).slice(0, 900)} (source: ${String(c.s).slice(0, 120)}, verified ${String(c.v).slice(0, 12)})`)
    .join("\n");
  const t0 = Date.now();
  try {
    const r = await callOpenAI({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Verified cards:\n${ctx}\n\nPerson: ${String(persona || "newcomer").slice(0, 40)}\nQuestion: ${q}` },
      ],
    });
    if (!r.ok) return res.status(502).json({ error: `openai ${r.status}` });
    const j = await r.json();
    const out = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    const ids = new Set(cards.map((c) => Number(c.id)));
    const card = out.card === null || out.card === undefined || !ids.has(Number(out.card)) ? null : Number(out.card);
    return res.status(200).json({
      card, lang: out.lang || "en", langName: out.langName || "", title: out.title || "", answer: String(out.answer || "").slice(0, 1200),
      model: MODEL, ms: Date.now() - t0, tokens: j.usage?.total_tokens ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: "ask failed" });
  }
}
