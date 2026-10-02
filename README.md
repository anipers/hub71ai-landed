# Landed: moving to Abu Dhabi, in the right order

Hub71+ AI Hackathon · team **landed**

**The problem.** Everything a newcomer needs already exists: ACCESSADGM, ICP, TAMM, UAE PASS, SEHA, banks, schools, ILOE and Hub71. It is scattered, so people find each tool too late or in the wrong order. A spouse's visa waits on the employee's Emirates ID, which waits on the medical test, which waits on the company's establishment card.

**What Landed does.** It builds one personal plan from a rules graph that links each person, their family and their company. Each step opens the existing tool at the right moment. Landed brings no new government system.

## What runs in this demo
- **Rules engine (DAG).** Finishing a step recalculates what unlocks for you and for the people linked to you, such as your spouse or your company. Every unlock has a reason and a source.
- **Personal agent on OpenAI (`/api/ask`).**
  - The agent knows this person's live plan: stage, what is done, what they can do now, who they are waiting on.
  - It answers in any language and suggests one next action for that person.
  - Facts come only from verified cards with a source. If no card answers, it refuses instead of inventing.
  - If the API is unreachable, an offline matcher answers instead.
- **PII firewall before the LLM.** The pipeline is Presidio-style: analyze → anonymize → LLM → deanonymize.
  - Names (deny-list recognizer), emails, phone numbers, Emirates ID numbers (784-…), IBANs, passports and cards become tags like `<PERSON_1>` before OpenAI sees the text.
  - Real values are restored only in the reply to the user.
  - The UI shows exactly what the model saw.
  - POC, not for prod: production runs Microsoft Presidio (analyzer + anonymizer, spaCy NER) as a Docker sidecar.
- **Districts.** Areas are ranked against the office and your priorities. Labels carry a source and follow the law: no protected attributes, and member labels only appear at k≥10.
- **Company view, operator dashboard (anonymous funnels) and safety layer.**
- **Life after 90 days.** Covers changing jobs, the grace period, ILOE, renewing a visa and leaving the UAE.

## Data
55 person steps, 7 company steps and 16 verified answer cards, each with a source URL and a verification date. The data is hand-curated test data for the demo.

## Run / deploy
- Static `index.html` plus one Vercel serverless function, `api/ask.js`.
- Set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4.1-mini`) in Vercel → Settings → Environment Variables. See `.env.example`.
- No secrets live in the repo.
