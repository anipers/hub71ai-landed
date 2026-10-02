// Vercel serverless function: personal relocation agent via OpenAI, with a PII firewall.
// Key lives only in the Vercel project env (OPENAI_API_KEY). Never commit it.
//
// PII firewall: Presidio-style analyze → anonymize → (LLM) → deanonymize.
// Recognizers mirror Microsoft Presidio entities: PERSON (deny-list recognizer), EMAIL_ADDRESS,
// PHONE_NUMBER, AE_EMIRATES_ID (784-YYYY-NNNNNNN-C), IBAN_CODE, PASSPORT, CREDIT_CARD, DATE_OF_BIRTH.
// POC, not for prod: production runs presidio-analyzer + presidio-anonymizer (spaCy NER) as a Docker sidecar.
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const PATTERNS = [
  ["EMAIL_ADDRESS", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["AE_EMIRATES_ID", /\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b/g],
  ["IBAN_CODE", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g],
  ["CREDIT_CARD", /\b(?:\d[ -]?){13,19}\b/g],
  ["PHONE_NUMBER", /(?:\+|00)\d{1,3}[\s-]?\d{1,4}(?:[\s-]?\d{2,4}){2,4}|\b05\d[\s-]?\d{3}[\s-]?\d{4}\b/g],
  ["PASSPORT", /\b[A-Z]{1,2}\d{6,8}\b/g],
  ["DATE_OF_BIRTH", /\b(?:born|DOB|date of birth)[:\s]+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/gi],
];

function anonymize(text, names, vault) {
  let out = String(text);
  const bump = (type, val) => {
    if (vault.rev.has(val)) return vault.rev.get(val);
    vault.n[type] = (vault.n[type] || 0) + 1;
    const tag = `<${type}_${vault.n[type]}>`;
    vault.map.set(tag, val); vault.rev.set(val, tag); return tag;
  };
  for (const [type, re] of PATTERNS) out = out.replace(re, (m) => bump(type, m));
  const nm = (names || []).filter((x) => typeof x === "string" && x.length > 1).sort((a, b) => b.length - a.length);
  for (const name of nm) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    out = out.replace(re, (m) => bump("PERSON", m));
  }
  return out;
}
const deanonymize = (text, vault) => String(text || "").replace(/<[A-Z_]+_\d+>/g, (t) => vault.map.get(t) ?? t);

const SYSTEM = `You are Landed, a personal relocation agent for one person moving to Abu Dhabi (ADGM / Hub71 ecosystem).
You know this person's live plan (profile below): what is done, what they can do now, what waits on others, what is locked.
Personal details are masked as tags like <PERSON_1>; keep tags exactly as written, never guess the real values.
Rules:
1. Detect the question's language (any language) and reply in it.
2. Facts (procedures, fees, deadlines, legal rules) may ONLY come from the verified cards. Pick the single card that answers; if none does, card = null and say there is no verified answer yet. Never invent facts.
3. Personalise using the profile: relate the answer to their stage, open steps and who they are waiting on.
4. "next": one concrete next action for THIS person taken from their "Can do now" or "Waiting on others" list, in the question's language.
Return strict JSON: {"card": <id or null>, "lang": "<ISO 639-1>", "langName": "<English name>", "title": "<short title in question language>", "answer": "<2-3 sentences>", "nextLabel": "<'For you, next' in question language>", "next": "<one sentence>"}`;

async function callOpenAI(body, attempt = 0) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 2) {
    await new Promise((res) => setTimeout(res, 400 * 2 ** attempt)); // retry with backoff on 429/5xx
    return callOpenAI(body, attempt + 1);
  }
  return r;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY not set" });
  const { q, cards, profile, names } = req.body || {};
  if (typeof q !== "string" || !q.trim() || q.length > 500) return res.status(400).json({ error: "bad question" });
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 120) return res.status(400).json({ error: "bad cards" });

  const vault = { map: new Map(), rev: new Map(), n: {} };
  const safeProfile = anonymize(String(profile || "").slice(0, 4000), names, vault);
  const safeQ = anonymize(q, names, vault);
  const types = {}; for (const t of vault.map.keys()) { const k = t.slice(1, t.lastIndexOf("_")); types[k] = (types[k] || 0) + 1; }

  const ctx = cards
    .map((c) => `[${Number(c.id)}] ${String(c.t).slice(0, 160)} :: ${String(c.a).slice(0, 900)} (source: ${String(c.s).slice(0, 120)}, verified ${String(c.v).slice(0, 12)})`)
    .join("\n");
  const t0 = Date.now();
  try {
    const r = await callOpenAI({
      model: MODEL, temperature: 0.2, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Verified cards:\n${ctx}\n\nProfile (masked):\n${safeProfile}\n\nQuestion: ${safeQ}` },
      ],
    });
    if (!r.ok) {
      let code = ""; try { const e = await r.json(); code = e?.error?.code || e?.error?.type || ""; } catch {}
      return res.status(502).json({ error: `openai ${r.status}${code ? " " + code : ""}` });
    }
    const j = await r.json();
    const out = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    const ids = new Set(cards.map((c) => Number(c.id)));
    const card = out.card === null || out.card === undefined || !ids.has(Number(out.card)) ? null : Number(out.card);
    return res.status(200).json({
      card, lang: out.lang || "en", langName: out.langName || "",
      title: deanonymize(out.title, vault), answer: deanonymize(out.answer, vault).slice(0, 1200),
      nextLabel: out.nextLabel || "", next: deanonymize(out.next, vault).slice(0, 400),
      pii: { count: vault.map.size, types, preview: (safeQ + "\n---\n" + safeProfile).slice(0, 900) },
      model: MODEL, ms: Date.now() - t0, tokens: j.usage?.total_tokens ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: "ask failed" });
  }
}
