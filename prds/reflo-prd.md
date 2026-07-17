# Reflo — Product Requirements Document

**Version:** 1.2 · **Date:** July 17, 2026 · **Status:** Approved for build sprint
**Changelog:** v1.2 — grounding rule clarified (inline citations for tutoring answers only), video degradation made an explicit product rule, ingestion added to the never-cut clause, pointer to AGENTS.md added
v1.1 — priority tiers corrected (not everything is P0), re-teach metric given a proper control, WhatsApp lead-time risk added, vector DB decision made, Builder Day added to plan
**Program:** AI Agent Builder Challenge (Alibaba Cloud × AMD × Beta University)
**Sprint:** July 17 – August 7, 2026 · **Demo Day:** August 15, 2026
**Ways of working:** this PRD defines scope, priorities, and quality bars. Operating instructions for agents/contributors (task pickup, memory files, conventions, escalation) live in `AGENTS.md` at the repo root.

---

## 1. Overview

Reflo is a self-improving AI tutor. It ingests any learning material — certification study guides, textbooks, company training documents — and generates a structured, multimodal curriculum: narrated audio, short explainer videos, and adaptive quizzes for every chapter. As the learner studies, Reflo maintains a persistent model of what they actually know, then acts on that model autonomously: re-teaching weak concepts in new ways, scheduling spaced-repetition reviews, and adapting difficulty and modality to how each person learns best.

The core thesis: every existing learning tool measures **completion**; Reflo measures and optimizes **retention**. The per-learner knowledge model compounds with use, forming the product's moat — the longer you use Reflo, the better it teaches you.

**Initial wedge market:** professionals preparing for high-stakes certifications (cloud certifications, nursing boards, CFA, bar exam), where learners already pay for prep and pass/fail outcomes make learning measurable. **Expansion market:** enterprise L&D — workforce training, onboarding, and compliance, where "prove your team actually retained this" is a budgeted problem.

---

## 2. Problem Statement

1. **Retention is invisible.** Learners consume books and courses but discover what they failed to absorb only at exam time. No mainstream tool tracks concept-level mastery over time.
2. **Materials are static and one-size-fits-all.** The same chapter is presented the same way to every learner, regardless of their background, weak spots, or preferred modality.
3. **AI tools are stateless.** ChatGPT, NotebookLM, and quiz generators produce one-off artifacts. None maintains a longitudinal model of the learner, so every session starts from zero.
4. **Forgetting is unmanaged.** Spaced repetition works (decades of evidence) but requires manual card-making discipline almost nobody sustains. Nothing automates it from arbitrary source material.

## 3. Goals & Non-Goals

### Goals (sprint horizon)
- **G1:** A learner can upload a study guide and receive a browsable curriculum outline within ~2 minutes, with per-chapter audio, video, and quizzes generating progressively (chapter 1 ready in ≤ 10 minutes).
- **G2:** Every interaction updates a per-concept knowledge-state model, visualized as a live knowledge map.
- **G3:** The Tutor Agent autonomously closes the loop: detects a weak concept, regenerates a targeted micro-lesson in a different modality/approach, and verifies improvement.
- **G4:** Spaced-repetition micro-quizzes delivered via WhatsApp/Telegram on a forgetting-curve schedule.
- **G5:** 10–20 real pilot learners actively prepping a certification before Demo Day, with retention metrics to show on stage.

### Non-Goals (explicitly out of scope for the sprint)
- Native mobile apps (mobile-first PWA only)
- Enterprise SSO/SCIM, multi-tenant admin dashboards (design for it; don't build it)
- Marketplace or social features, learner-to-learner interaction
- Fine-tuning custom models (prompted foundation models only)
- Regulated-education compliance (FERPA/minors) — adult professional learners only
- Live coding-exercise sandbox for technical certs (fast-follow; see §7)

---

## 4. Users & Personas

**P1 — The Certification Candidate (primary).** 25–45, working professional, studying for AWS/Alibaba Cloud/PMP/CFA/NCLEX on nights and commutes. Pays $30–80/mo for prep tools today. Pain: limited study time, no idea if they're ready. Success: passes the exam; knows their readiness before test day.

**P2 — The Self-Directed Learner (secondary).** Reads non-fiction and technical books, wants to actually retain them. This is the founding use case and the community/word-of-mouth engine. Monetizes at consumer subscription rates.

**P3 — The L&D Manager (future buyer, design-for).** Runs compliance and onboarding training for 200–5,000 employees. Pain: completion rates are theater; audits and incidents reveal nobody retained anything. Buys per-seat. Not built this sprint, but data model and tenancy decisions must not preclude them.

---

## 5. Product Principles

1. **The knowledge model is the product.** Every feature either feeds the model (assessment) or acts on it (adaptation). Content generation is in service of this loop, never the headline.
2. **Agent, not library.** Reflo decides what you study next. The learner can always override, but the default experience is directed.
3. **Grounded, always.** Every lesson, quiz, and answer must be traceable to the uploaded source material (RAG-grounded). No hallucinated curriculum. Conversational tutoring answers carry inline citations to chapter/section (§11); lessons and quizzes must be source-traceable but do not carry inline citations.
4. **Respect the learner's time.** Sessions are effective in 10-minute increments. Micro-lessons over lectures.
5. **Honest measurement.** Never inflate mastery to flatter the user. Readiness scores must be calibrated — the product's credibility is its accuracy.

---

## 6. Core Features (MVP — Demo Day scope)

### F1. Ingestion & Curriculum Builder — *P0*
- Upload PDF, EPUB, DOCX (≤ 50 MB, ≤ 800 pages for MVP)
- Pipeline: parse → clean → chunk → embed (vector DB) → Curriculum Agent structures content into chapters → concepts, with prerequisite ordering
- Output: a course object with per-chapter concept lists, visible to the learner as a course outline within ~2 minutes (curriculum first; media generates progressively in background)
- Edge cases: scanned PDFs (OCR fallback), malformed files (clear error + supported-format guidance)

### F2. Multimodal Lesson Generation — *P0*
- Per chapter: (a) narrated audio lesson, 5–10 min, via TTS (Qwen-TTS through Model Studio); (b) one short explainer video, 60–120 s, via Wanx for the chapter's hardest concept; (c) text micro-lessons per concept
- Generation is queue-driven (RocketMQ) and progressive — chapter 1 assets ready fast, rest fill in; UI shows generation status per chapter
- All assets stored in OSS, streamed via CDN
- Quality bar: audio listenable at 1.5×; video visually explains (diagrams/motion), not a slideshow of text
- Degradation rule: video is an enhancement, never a blocker. If Wanx/GPU capacity is unavailable or slow, the chapter ships with audio + text and video backfills later; no learner-facing flow may hard-depend on video existing

### F3. Adaptive Assessment Engine — *P0*
- Per-chapter quiz bank generated at ingestion: multiple choice, short answer (LLM-graded), and concept-linking items; each question tagged to concept ID(s)
- Adaptive selection: question difficulty and concept targeting driven by current knowledge state
- Short-answer grading via LLM with rubric, confidence-thresholded; low-confidence grades flagged, never silently wrong
- Anti-pattern guard: never repeat the identical question within a session; vary surface form to test the concept, not memorization of the item

### F4. Learner Knowledge Model — *P0 (the moat)*
- Per (learner, concept): mastery estimate (0–1), confidence, last-reviewed timestamp, review count, forgetting-curve half-life
- Updated by every quiz answer, question asked, lesson completed/abandoned
- Algorithm: Bayesian mastery update + FSRS-style spaced-repetition scheduling (proven open algorithm; do not invent novel psychometrics during a 3-week sprint)
- Surfaced as the **Knowledge Map**: a visual per-chapter/concept heat map with an overall calibrated Readiness Score for the target exam
- This model is the input to F5 and F6 and the centerpiece of the demo

### F5. Tutor Agent (adaptive loop) — *P0*
- Session orchestrator: each study session, the agent selects the next best action — advance to new material, re-teach a weak concept, or trigger review — from the knowledge model
- **Re-teach behavior (the demo money-shot):** when mastery of a concept stays low after a lesson, the agent regenerates a *different* explanation — new analogy, new modality (e.g., video instead of text), simpler decomposition — then re-tests
- Conversational tutoring: learner can ask questions anytime; answers RAG-grounded in the source with citations to chapter/section
- Voice mode — *P1*: audio Q&A for commute study (reuse TTS + streaming chat). Build only if Weeks 1–2 exit criteria are met on time; demo can show it as a recorded clip (resolves §15 Q4: default answer is "clip unless ahead of schedule")

### F6. Spaced-Repetition Delivery — *P0*
- Daily micro-quiz (1–3 questions) delivered at the learner's chosen time, scheduled by the forgetting-curve model. Channel priority: **Telegram first (P0, no approval gate), WhatsApp when Business approval lands (P1)**, email fallback always
- Answers flow back into the knowledge model; streaks shown for retention motivation
- Function Compute cron triggers; graceful fallback to email if messaging opt-out

### F7. Accounts, Library & Progress — *P0 core, P1 extras*
- *P0:* Auth (email + OAuth), personal library of courses, session history, account deletion (hard-delete of PII and content)
- *P1:* Stripe subscription flow (feature-flagged; only if §15 Q1 resolves to paid pilots), self-serve data export (manual export on request is acceptable during the sprint — GDPR-aligned either way, per application commitments)

---

## 7. Fast-Follow (post–Demo Day, pre-committed roadmap)
- **Coding-exercise sandbox** (Agent Run): generate/grade live coding tasks for technical certs
- **Enterprise tenanting:** org accounts, seat management, admin retention dashboards, SSO
- **Multilingual delivery:** same source, taught in learner's language (Qwen strength)
- **Marketplace of prepared courses** for popular certifications (openly licensed / partner content)
- **Mobile apps** replacing PWA

---

## 8. User Flows (primary)

**Flow A — First course (activation):** Sign up → upload study guide → watch curriculum appear (~2 min) → take 10-question placement quiz → see initial Knowledge Map → begin chapter 1 lesson (audio or text) → chapter quiz → map updates. *Target: upload → first completed lesson in ≤ 15 minutes.*

**Flow B — The adaptive loop (core retention loop):** Open app → agent proposes today's plan ("Review 2 fading concepts, then Chapter 4") → learner fails questions on Concept X → agent generates alternative micro-lesson for X → re-test → mastery rises → map visibly improves → session summary with readiness delta.

**Flow C — Ambient reinforcement:** 8 am WhatsApp micro-quiz → learner answers inline → model updates → weekly readiness digest.

**Flow D — Ask anything:** Learner highlights confusion mid-lesson → asks in chat/voice → grounded answer with source citation → "still confused" → escalates to regenerated explanation.

---

## 9. System Architecture (summary)

*(Consistent with the application form; details there govern infra commitments.)*

- **Frontend:** Next.js PWA (web app + mobile), served via CDN
- **Backend:** ECS app tier (API + orchestrator), Function Compute for event/cron jobs, RocketMQ for generation pipeline fan-out
- **Agents:** Hybrid architecture — deterministic pipelines (ingestion, media generation) + agentic layer (Curriculum Agent, Tutor Agent, Assessment Agent) coordinated by a learner-state-driven orchestrator
- **Models via Model Studio:** Qwen (tutoring dialogue, quiz generation/grading, curriculum structuring), Wanx (video), Qwen-TTS (audio); multi-model routing by task/cost
- **GPU:** batch media generation on GPU instances; AMD/ROCm optimization track with AMD mentors during sprint
- **Data:** RDS PostgreSQL (system of record incl. knowledge-state), Redis (sessions, queues, cache), OSS (source docs + generated media)
- **Vector store — decision made:** AnalyticDB for PostgreSQL (pgvector-compatible) for the sprint — one fewer moving part and Postgres-native ops for a 3-person team; migrate to Milvus only if corpus scale demands it post-launch. Validate this choice with Alibaba engineers at Builder Day (Jul 16)
- **Security:** isolated VPC, encryption at rest, Singapore region residency, Stripe tokenization (no card data), tenant-isolated content embeddings, PII-minimized prompts
- **Observability:** Langfuse tracing + Alibaba SLS; offline eval suites for quiz quality and grading accuracy (see §11)

---

## 10. Data Model (core entities)

`User` (id, auth, prefs, channel opt-ins) · `Course` (id, owner, source_doc→OSS, status) · `Chapter` (course_id, order, title) · `Concept` (chapter_id, name, prerequisite_ids) · `Asset` (concept/chapter_id, type: audio|video|text|quiz, OSS URI, gen_metadata) · `QuizItem` (concept_ids[], type, difficulty, rubric) · `Attempt` (user, quiz_item, answer, grade, confidence, ts) · `KnowledgeState` (user, concept, mastery, half_life, last_review, review_count) · `Session` (user, plan, actions[], summary) · `AgentTrace` (→ Langfuse ref)

---

## 11. Quality, Evaluation & Safety

- **Quiz-quality eval:** held-out chapters → generated questions rated for answerability-from-source, correctness of keyed answer, and distractor plausibility; target ≥ 95% keyed-answer correctness before pilot launch
- **Grading-accuracy eval:** LLM short-answer grades vs. human-labeled set; publish agreement rate internally; low-confidence → multiple-choice fallback
- **Grounding:** all tutoring answers cite source spans; "I don't find this in your material" is a valid and required behavior
- **Calibration:** Readiness Score validated against pilot users' practice-exam scores where available
- **Content rights:** demo and pilots use openly licensed certification guides or learner-owned material; enterprise path = customer-owned content (rights question dissolves)
- **Privacy:** assessment data treated as sensitive PII; export/delete self-serve; no learner data used to train shared models

---

## 12. Success Metrics

**Demo Day proof points (Aug 15):**
- Live loop on stage: upload → generated lessons → failed question → agent re-teaches differently → learner passes (≤ 6 min demo)
- 10–20 active pilot learners; ≥ 60% D7 retention among pilots (requires first pilots live by Aug 1 — see revised Week 2 exit)
- Measured retention lift with a real control: within-learner comparison of re-test scores on **agent-re-taught concepts vs. matched concepts reviewed by simple repetition**; target ≥ 15pp advantage. (Comparing re-teach to first attempt alone is confounded by practice effects and regression to the mean — a sharp investor will catch that, so we won't present it.)
- Infra story told: Qwen + Wanx + TTS + OSS + AnalyticDB + SLS in production; ROCm benchmark result with AMD

**Post-launch North Star:** *verified concepts retained per learner per week.* Supporting: activation (upload→first lesson ≤ 15 min, ≥ 50% of signups), weekly active learners, spaced-rep response rate ≥ 40%, certification pass rate (long-term), consumer conversion to paid ≥ 5% at $29/mo.

---

## 13. Sprint Plan (July 16 – Aug 7)

**Builder Day (Jul 16) — extract maximum value.** Concrete asks, prepared in advance: (1) GPU quota approval for Wanx/TTS workloads in Singapore region, (2) Model Studio rate limits raised for batch generation, (3) validate AnalyticDB-vs-Milvus decision with an Alibaba engineer, (4) get named AMD contact for the ROCm benchmark track, (5) ask which openly licensed Alibaba Cloud ACA study materials exist (resolves §15 Q2). Also: start WhatsApp Business approval and pilot-recruitment outreach **today** — both have lead times that Week 3 cannot absorb.

**Week 1 (Jul 17–23) — Pipeline & skeleton.** Ingestion pipeline end-to-end (parse→embed→curriculum), Model Studio + Wanx/TTS integration, OSS/CDN, auth + library UI, quiz generation v1. Pilot waitlist of 30+ candidates recruited (target: exam date < 60 days out). *Exit: upload a PDF, get a browsable curriculum with one generated audio + quiz.*

**Week 2 (Jul 24–30) — The loop.** Knowledge model + FSRS scheduling, adaptive quiz selection, Tutor Agent re-teach behavior, Knowledge Map UI, Telegram delivery (WhatsApp when approved), Langfuse/SLS wiring. *Exit: Flow B works end-to-end; **first 5 pilots live by Jul 30** (not merely invited — D7 retention needs a week of runway before the Aug 7 metrics cut).*

**Week 3 (Jul 31–Aug 7) — Pilots & polish.** 10–20 pilot learners live, grading/quiz eval suites run and issues fixed, voice mode, ROCm benchmark with AMD mentors, readiness score calibration, demo hardening (offline fallbacks, seeded demo course). *Exit: demo runs reliably in ≤ 6 min; pilot metrics collected.*

**Aug 8–14 — Demo Day prep.** Pitch narrative, live-demo rehearsals (≥ 10 runs), metrics slide from pilot data, failure-mode rehearsal (pre-generated fallback assets).

---

## 14. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wanx video quality/latency insufficient for per-chapter videos | Medium | One hero video per chapter only; pre-generate for demo; audio+text carry the lesson load |
| LLM grading errors erode trust | Medium | Confidence thresholds, MC fallback, eval suite gate before pilots |
| GPU quota delays block media pipeline | Medium | Flagged in application; escalate at Builder Day; text/audio degrade gracefully |
| Scope creep (6 features → 12) | High | This PRD is the contract; anything not in §6 goes to §7 |
| Live demo failure | Medium | Seeded demo course, pre-generated fallback assets, rehearsed offline mode |
| Copyright question on stage | Low | Openly licensed demo material; §11 talking points ready |
| Retention theater (pilots sign up, don't return) | Medium | Daily messaging delivery is the hook; recruit pilots with a real exam date < 60 days out |
| WhatsApp Business approval doesn't land in time | Medium–High | Telegram is the P0 channel (no approval needed); WhatsApp is an upgrade, not a dependency — approval started Jul 16 |
| Too many P0s for a 3-person team | High | Cut order pre-agreed if Week 2 slips: 1) voice mode (already P1), 2) video per chapter → demo-course only, 3) OAuth → email-only auth. The knowledge model + re-teach loop is never cut, nor is ingestion (F1) — without it the loop cannot be demonstrated |

---

## 15. Open Questions
1. Pricing test at pilot: free pilot vs. discounted paid (paid pilots = stronger Demo Day signal; decide by end of Week 2)
2. Demo certification: Alibaba Cloud ACA is the strategic pick — confirm openly licensed material exists (ask at Builder Day, Jul 16; fallback: an openly licensed cloud/PM guide)
3. Placement quiz length: 10 questions (fast activation) vs. 20 (better initial model) — A/B during pilots
4. ~~Voice tutoring live or clip~~ — resolved in F5: recorded clip unless ahead of schedule after Week 2
5. Name/trademark check: confirm "Reflo" clear in US/SG before Demo Day branding (owner: assign at kickoff; 30-minute task, do it this week)

---

*Owner: Founding team · Reviewers: Builder Day mentors (Alibaba Cloud, AMD) · Next revision: end of Week 1 with actuals.*