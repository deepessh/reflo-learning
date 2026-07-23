# Reflo — Product Requirements Document

**Version:** 1.9 · **Date:** July 22, 2026 · **Status:** Approved for build sprint
**Changelog:** v1.9 — separated product requirements from architecture authority; retained product behavior, priorities, safety/privacy outcomes, SLOs, pilot gates, offline behavior, and honest labeling while moving providers, topology, storage, schema catalogs, algorithms, and implementation mechanisms to accepted ADRs
v1.8 — narrowed the sprint video scope to one source-backed nominal 15-second Wan prototype; deferred production 60–120 second composition and full-course video generation to fast-follow
v1.7 — removed fixed deployment-location constraints; provider selection still must satisfy the existing privacy, security, consent, quality, and production-path gates
v1.6 — decision authority split by role: this PRD controls product requirements and mandates, GitHub issues authorize implementation/process choices, and merged `DECISIONS.md` records make those verdicts effective and searchable
v1.5 — pilot-blocking evaluations moved before activation; D7 observation window corrected; provider-scoped delivery/attempt uniqueness made implementable; sessionless ambient attempts clarified; deletion audit detached from deleted identities; per-evidence knowledge-algorithm provenance added
v1.4 — delivery/scheduling, scope membership, exam mapping, per-concept evidence, tutor-turn provenance, and deletion-store models added; performance and re-teach gates made executable; TTS fallback, prompt-injection tests, pilot consent, D7 event semantics, email interaction, and offline-demo envelope specified; OAuth moved to P1
v1.3 — acceptance SLOs made internally consistent; knowledge evidence separated from engagement; artifact provenance, grading abstention, readiness-score eligibility, pilot cohort analysis, upload security, and deletion requirements specified; video and voice priorities aligned; sprint dates and channel flows corrected
v1.2 — grounding rule clarified (inline citations for tutoring answers only), video degradation made an explicit product rule, ingestion added to the never-cut clause, pointer to AGENTS.md added
v1.1 — priority tiers corrected (not everything is P0), re-teach metric given a proper control, WhatsApp lead-time risk added, vector DB decision made, Builder Day added to plan
**Program:** AI Agent Builder Challenge (Alibaba Cloud × AMD × Beta University)
**Sprint:** July 17 – August 7, 2026 · **Demo Day:** August 15, 2026
**Ways of working:** this PRD defines product outcomes, user-visible behavior, scope, priorities, safety and privacy outcomes, SLOs, pilot and release gates, offline-demo behavior, and honest labeling. Accepted records under `docs/adrs/` authorize architecture. The non-authoritative `docs/architecture.md` view separates decided targets from evidence-backed implemented state. Operating instructions for agents/contributors live in `AGENTS.md`.

---

## 1. Overview

Reflo is a self-improving AI tutor. It ingests supported learning materials — certification study guides, textbooks, company training documents — and generates a structured curriculum with per-chapter text, narrated audio, and adaptive quizzes; short explainer video is an optional enhancement. As the learner studies, Reflo maintains a persistent model of what confidently graded evidence shows they know, then acts on that model autonomously: re-teaching weak concepts in new ways, scheduling spaced-repetition reviews, and adapting difficulty and modality to how each person learns best.

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
- **G1:** For a supported, digitally generated source within the standard-ingestion profile (PDF/EPUB/DOCX, ≤ 20 MB, ≤ 200 pages, no OCR), a learner receives a browsable curriculum outline at p95 ≤ 2 minutes, the first text micro-lesson plus placement quiz at p95 ≤ 5 minutes, and chapter 1 audio at p95 ≤ 10 minutes. Files up to the 50 MB/800-page product maximum remain supported but use an asynchronous large-document path with an estimate/status, as do OCR jobs; neither carries the 2-minute SLO. Remaining audio and quizzes generate progressively. Video is a P1 enhancement and never part of an activation SLO.
- **G2:** Every learning interaction is recorded as an event. Only confidently graded assessment evidence updates per-concept mastery and forgetting state; lesson/question/completion events update exposure, engagement, and modality state without directly changing mastery. The resulting state is visualized as a live knowledge map.
- **G3:** The Tutor Agent autonomously closes the loop: detects a weak concept, regenerates a targeted micro-lesson in a different modality/approach, and verifies improvement.
- **G4:** Spaced-repetition micro-quizzes delivered through Telegram (P0) or opted-in email fallback on a forgetting-curve schedule; WhatsApp is a P1 channel when Business approval lands.
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
- Standard-ingestion profile for activation SLOs: digitally generated files ≤ 20 MB and ≤ 200 pages that do not require OCR. Larger supported files use the asynchronous large-document path.
- Secure ingestion produces cleaned, source-spanned content and a prerequisite-ordered chapter/concept curriculum; the governing architecture defines the pipeline and storage mechanisms
- Output for the standard-ingestion profile: a course object with per-chapter concept lists visible at p95 ≤ 2 minutes; media generates progressively in the background. SLO measurement begins after upload completion and ends when the outline is usable.
- Scanned PDFs enter an asynchronous OCR path with visible progress and a time estimate. Malformed, encrypted, unsupported, or over-limit files fail with a clear reason and supported-format guidance.
- Treat uploads as untrusted: verify declared type against file content, scan for malware, enforce compressed/uncompressed and page limits, and isolate parsing/OCR from ambient credentials and network access.

### F2. Multimodal Lesson Generation — *P0 audio + text; P1 video*
- P0 per chapter: (a) narrated audio lesson, 5–10 min; (b) text micro-lessons per concept, including a 2–3 minute first micro-lesson for activation
- P0 audio capacity must not rely on an unresolved quota. Before Week 1 exit, verify reserved primary capacity and a second quota-independent fallback. Both paths must produce the same learner-visible asset behavior and pass the audio quality/SLO gate. Any paid capacity requires the human spending approval in `AGENTS.md`. If neither path is verified, the P0 audio exit criterion has not passed.
- P1 sprint prototype: one source-backed nominal 15-second video for a chapter's hardest concept, behind the default-off video flag and labeled as a prototype unless the separate runtime eligibility gates pass. It is not a learner-flow dependency or a production per-chapter-video commitment. Production 60–120 second composition and full-course video generation are fast-follow work.
- Generation is progressive — chapter 1 assets become ready first, the rest fill in, and the UI shows generation status per chapter
- All assets retain source provenance, generation provenance, and status; private assets are available only through short-lived authorized delivery
- Quality bar: audio listenable at 1.5×; video visually explains (diagrams/motion), not a slideshow of text
- Degradation rule: video is an enhancement, never a blocker. If video capacity is unavailable or slow, the chapter ships with audio + text; no learner-facing flow may hard-depend on the prototype or any future video existing

### F3. Adaptive Assessment Engine — *P0*
- Quiz banks generate progressively during ingestion, prioritizing the placement quiz and chapter 1. They include multiple choice, short answer (LLM-graded), and concept-linking items; each question is tagged to concept ID(s) and supporting source spans.
- Adaptive selection: question difficulty and concept targeting driven by current knowledge state
- Short-answer grading via LLM with rubric and a versioned confidence threshold. A low-confidence result creates an `abstained` attempt, tells the learner the answer could not be graded reliably, and offers a multiple-choice replacement. Abstained attempts never update mastery; only the confidently graded replacement can do so.
- For an item tagged to multiple concepts, grading produces immutable, reproducible evidence for each concept rather than copying one overall grade to every concept. Partially correct answers update only concepts with confident evidence.
- Anti-pattern guard: never repeat the identical question within a session; vary surface form to test the concept, not memorization of the item. Ambient answers remain attributable to the delivered question even without an app session.

### F4. Learner Knowledge Model — *P0 (the moat)*
- Per learner and concept, retain a 0–1 mastery estimate, confidence, review history, and forgetting state.
- Record every quiz answer, question asked, and lesson completed/abandoned. Only confidently graded retrieval attempts are assessment evidence and may update mastery or forgetting state. Exposure and engagement may affect recommendations and modality preferences but must not raise or lower mastery. Every update is versioned and reproducible.
- Surfaced as the **Knowledge Map**: a visual per-chapter/concept heat map. Show an overall **Exam Readiness Score** only when the course is mapped to a versioned target-exam blueprint with reviewed, provenance-carrying concept mappings. Unmapped concepts are excluded and disclosed; insufficient objective mapping or evidence coverage blocks the overall score. Regenerating concepts invalidates affected mappings until remapped. The score appears only after blueprint evidence minimums are met; otherwise label the aggregate **Course Mastery Estimate** and do not claim exam calibration.
- This model is the input to F5 and F6 and the centerpiece of the demo

### F5. Tutor Agent (adaptive loop) — *P0*
- Session orchestrator: each study session, the agent selects the next best action — advance to new material, re-teach a weak concept, or trigger review — from the knowledge model
- **Re-teach behavior (the demo money-shot):** when confidently graded evidence shows that mastery remains low after a lesson, the agent generates or selects a materially different explanation — a new analogy, a different available modality, or a simpler decomposition — then re-tests. Mastery changes only from the re-test result, not from viewing the replacement lesson.
- Executable trigger: after lesson exposure, the latest confidently graded attempt is incorrect or below its rubric pass band, the concept mastery is < 0.60, and at least two confidently graded attempts exist for that concept. A replacement must use a different versioned strategy tag and either a different modality or a different explanation structure; after citation text is removed, semantic similarity to the prior lesson must be < 0.85. Allow at most two replacement lessons per concept per session. After another failed re-test, stop the loop, acknowledge the gap, schedule a later review, and offer learner/human escalation—never inflate mastery or retry indefinitely.
- Demo assertion: the seeded Flow B passes only when the trigger fires from stored evidence, a qualifying different lesson is served, a confidently graded re-test is correct, the versioned algorithm raises mastery from that evidence alone, and the UI displays the resulting delta.
- Conversational tutoring: learner can ask questions anytime; answers RAG-grounded in the source with citations to chapter/section
- Voice mode — *P1*: audio Q&A for commute study (reuse TTS + streaming chat). Build only if Weeks 1–2 exit criteria are met on time; demo can show it as a recorded clip (resolves §15 Q4: default answer is "clip unless ahead of schedule")

### F6. Spaced-Repetition Delivery — *P0*
- Daily micro-quiz (1–3 questions) delivered at the learner's chosen time, scheduled by the forgetting-curve model. Channel priority: **Telegram first (P0, no approval gate), opted-in email fallback, WhatsApp when Business approval lands (P1)**
- Answers flow back into the knowledge model; streaks shown for retention motivation
- Persist each due review separately from delivery attempts. One delivery batches 1–3 due reviews for a channel. Retries reuse the logical delivery and cannot create duplicate attempts.
- Fallback to email only when the learner has opted into email delivery. Inbound messaging requires authenticated provider callbacks, replay protection, and explicit account linking before an answer can update learner state. Provider retries or webhook replays cannot create duplicate attempts, and ambient answers remain linked to the delivered item.
- Email is link-based, not reply-parsed: the message contains a single-use signed HTTPS link that expires after 24 hours and opens the authenticated mobile-web quiz. Redemption is bound to the intended user and delivery, is replay-safe, and records each answer against the intended delivered item. Do not ingest free-form email replies.

### F7. Accounts, Library & Progress — *P0 core, P1 extras*
- *P0:* Email auth, personal library of courses, session history, self-serve account deletion, and an authenticated manual data-export request path. OAuth is P1; email-only auth fully satisfies P0 acceptance.
- Deletion removes or irreversibly crypto-shreds learner-linked PII/content from every active and derived store, queue, delivery system, trace, evaluation export, and identifiable pilot-analysis dataset, including the otherwise append-only event history. While deletion is active or failed, the operation may retain the user association needed for retries and terminal failure visibility. On success it emits a non-linkable audit receipt containing only an opaque random receipt ID, timing, per-store outcome categories/counts, and backup-expiry date; then it destroys the subject lookup key. The completed receipt contains no deleted identifier. Active/derived stores complete within 24 hours; encrypted backups expire within 30 days. Only previously produced, irreversibly anonymized aggregates may remain, subject to the learner's recorded consent. The UI states these rules before confirmation.
- *P1:* OAuth, subscription flow (feature-flagged; only if §15 Q1 resolves to paid pilots), and self-serve export generation. During the sprint, an authenticated export request may be fulfilled manually within 7 days and is tracked to completion.

---

## 7. Fast-Follow (post–Demo Day, pre-committed roadmap)
- **Production explainer video:** source-backed 60–120 second explainers, including multi-segment continuity, trusted composition, and full-course generation
- **Coding-exercise sandbox** (Agent Run): generate/grade live coding tasks for technical certs
- **Enterprise tenanting:** org accounts, seat management, admin retention dashboards, SSO
- **Multilingual delivery:** same source, taught in the learner's language
- **Marketplace of prepared courses** for popular certifications (openly licensed / partner content)
- **Mobile apps** replacing PWA

---

## 8. User Flows (primary)

**Flow A — First course (activation):** Sign up → upload a standard-profile study guide → watch curriculum appear (p95 ≤ 2 min) → take the 10-question placement quiz → see the initial Knowledge Map → complete the 2–3 minute chapter 1 text micro-lesson → chapter quiz → map updates. *Target: upload complete → first text micro-lesson completed at p95 ≤ 15 minutes; OCR documents are excluded and show a separate estimate.*

**Flow B — The adaptive loop (core retention loop):** Open app → agent proposes today's plan ("Review 2 fading concepts, then Chapter 4") → learner fails questions on Concept X → agent generates or selects an alternative micro-lesson for X → re-test → mastery rises only if the confidently graded evidence supports it → map reflects the result → session summary with a mastery delta (and readiness delta only for an exam-mapped course).

**Flow C — Ambient reinforcement:** 8 am Telegram micro-quiz → learner answers inline; or opted-in email → learner follows the single-use signed link and answers in the mobile web quiz. Both paths create one replay-safe delivery-item-linked attempt per answered question → model updates from confidently graded per-concept evidence → weekly mastery/readiness digest. WhatsApp may provide the Telegram-style flow when the P1 channel is approved and enabled.

**Flow D — Ask anything:** Learner highlights confusion mid-lesson → asks in chat (or P1 voice when enabled) → grounded answer with source citation → "still confused" → escalates to regenerated explanation.

---

## 9. Product Constraints & Architecture Authority

*This PRD is authoritative for product outcomes, user-visible behavior, scope, priorities, safety and privacy outcomes, SLOs, pilot and release gates, offline-demo behavior, and honest labeling. Accepted records under [`docs/adrs/`](../docs/adrs/) authorize architecture. [`docs/architecture.md`](../docs/architecture.md) is a non-authoritative view that keeps decided targets separate from evidence-backed implemented state. GitHub `decision` issues hold proposals, evidence, discussion, and authorization; a verdict becomes effective only when its matching ADR merges. A GitHub verdict without a merged ADR is not effective. An ADR cannot waive or change this PRD's product requirements.*

- **Security and scope isolation:** learner content, assessments, and private assets are encrypted and isolated to an authorized owner scope. Every access path, retrieval, asset delivery, and mutation verifies active authorization. The MVP creates personal scopes only; organization scopes and non-owner roles remain design-for, not user-visible functionality. Worker privileges are least-privilege, private assets use short-lived authorized delivery, and deletion is auditable.
- **Provider privacy:** messaging, payment, model, and storage providers may process only the minimum data required for an explicitly consented purpose. Provider retention, training, and deletion settings must be verified before pilots. Model and trace payloads minimize PII and exclude uploaded passages, answers, contact details, and other sensitive data by default.
- **Untrusted-content boundary:** uploaded/retrieved text is data, never system or tool instruction. Source content cannot change prompts, authorization filters, tool permissions, grading rubrics, or citation rules. Apply scope filters before retrieval enters model context; agents receive no general network/shell authority and only narrowly typed, least-privilege tools. Render citations from server-resolved source-span IDs rather than model-supplied URLs or labels.
- **Observability:** product behavior is traceable with pseudonymous identifiers and supports the offline evaluation suites in §11. Traces follow the deletion and retention policy.
- **Demo offline mode:** "offline" means public internet, model APIs, production backend, and CDN may all be unavailable after a successful rehearsal preflight. A local demo bundle/service worker caches the app shell, seeded course outline and source-span manifest, text/audio assets, two alternative lessons, deterministic multiple-choice items/keys, initial knowledge state, and session-summary logic. It uses a clearly labeled demo-only local identity and local keyed grading; it must support course open → failed question → alternate lesson → re-test → Knowledge Map update → summary without external calls. Upload, new generation, short-answer LLM grading, messaging, OAuth, and production auth are explicitly unavailable in offline mode and are demonstrated separately. Never present pre-generated offline behavior as live generation.

---

## 10. Product Data Requirements

- Preserve source provenance for every curriculum concept, lesson, quiz item, and tutoring answer.
- Isolate courses, source material, generated assets, retrieval content, and learner records by authorized owner scope.
- Keep assessment evidence reproducible at the concept level, distinguish abstained and superseded outcomes, and prevent exposure or engagement events from changing mastery.
- Keep sessions, ambient deliveries, retries, and provider submissions attributable and replay-safe without creating duplicate attempts.
- Version exam blueprints, objective mappings, grading rules, knowledge updates, consent, and experiment assignment so displayed results and analysis are auditable.
- Keep deletion progress visible while retries are possible; after successful deletion, retain only a non-linkable audit receipt and permitted irreversibly anonymized aggregates.

---

## 11. Quality, Evaluation & Safety

- **Performance/SLO gate:** maintain a versioned benchmark of at least 40 rights-cleared, standard-profile documents spanning PDF/EPUB/DOCX, 5–200 pages, 0.5–20 MB, tables/images, and simple/complex chapter structures. Run from cold application/model caches in the target production deployment with five concurrent ingestions and at least three runs per document. Measure upload-complete → usable outline, first rendered text micro-lesson + complete 10-question placement quiz, and playable chapter 1 audio against the G1 p95 thresholds. Count retries, terminal failures, and timeouts as misses. A "usable outline" means the course opens, every detected chapter has a title and at least one source-backed concept or an explicit empty/error state, and source links resolve; the 5-minute activation package requires rendered source-backed text plus ten answerable/source-backed placement items. Publish benchmark version, environment, sample count, misses, and latency distribution; a handful of favorable documents cannot satisfy the gate.
- **Audio availability gate:** run at least 30 representative chapter scripts through both primary and fallback TTS paths under the same five-course concurrency profile. Each path must meet chapter 1 p95 ≤ 10 minutes, produce a playable authorized asset, and have zero unintelligible samples in two-reviewer listening QA at 1.0× and 1.5×. Record capacity/quota evidence and fail Week 1 if either required path is unavailable.
- **Quiz-quality eval:** on at least 100 generated questions across at least 5 held-out chapters, rate answerability-from-source, keyed-answer correctness, and distractor plausibility; require ≥ 95% keyed-answer correctness and ≥ 90% answerability before pilot launch. Report sample size and counts, not percentages alone.
- **Grading-accuracy eval:** on at least 100 human-labeled short answers spanning correct, partially correct, incorrect, and unanswerable responses, require ≥ 90% exact agreement with adjudicated labels and ≥ 95% agreement within one rubric band before pilot launch. The frozen confidence threshold must send low-confidence results to the multiple-choice fallback and must achieve ≥ 95% precision among auto-graded attempts. Abstentions do not update mastery.
- **Artifact grounding eval:** 100% of curriculum concepts, lessons, quiz items, and tutoring answers must persist valid source-span references. On a held-out sample of at least 100 generated claims across artifact types, require ≥ 95% to be entailed by the cited span, with zero unsupported high-severity safety claims. Tutoring answers display citations; lessons and quizzes retain auditable provenance without requiring inline citations. "I don't find this in your material" is a valid and required behavior.
- **Adversarial document gate:** test at least 20 documents containing indirect prompt injection, fake citations, cross-scope references, grading-manipulation instructions, and tool-use requests. Release requires zero cross-scope disclosures, zero authorization/tool-policy changes caused by source text, zero execution of source-supplied instructions, and zero displayed citations that do not resolve server-side to an authorized source span. Any such failure blocks pilots regardless of aggregate pass rate.
- **Calibration:** An Exam Readiness Score is eligible for display only for a versioned exam blueprint and only after its configured evidence minimum is met. Validate it against practice-exam scores where available and show the sample size and error; until validation is adequate, label it "experimental." All other courses show Course Mastery Estimate.
- **Content rights:** demo and pilot sources must appear on a human-approved list with recorded license/permission evidence. Learners uploading their own material attest that they have permission to process it; ownership alone is not treated as proof that all uses are licensed. Enterprise customers remain responsible for source rights under human-approved terms.
- **Pilot consent:** before activation, show versioned informed consent covering learning-data collection, messaging, randomized re-teach assignment, analysis purposes, Demo Day aggregate reporting, retention, and withdrawal. Store consent separately from learning events. Only explicitly opted-in pilots enter the randomized experiment. Withdrawal stops future interventions/messages, removes identifiable data under F7, and excludes that learner from subsequent individual-level analysis; report withdrawal counts and resulting denominator changes without retaining a linkable reason. Previously produced aggregates may remain only when irreversibly anonymized and permitted by the consent version.
- **Privacy:** assessment data is treated as sensitive PII; deletion is self-serve, export is available through an authenticated request (manual fulfillment is acceptable during the sprint), and no learner data is used to train shared models. Active/derived-store deletion or crypto-shredding completes within 24 hours and encrypted backups expire within 30 days as defined in F7. The append-only event rule applies only while the learner record is active and never overrides deletion or consent withdrawal.

---

## 12. Success Metrics

**Demo Day proof points (Aug 15):**
- Live adaptive loop on a pre-ingested seeded course: failed question → materially different micro-lesson → re-test → evidence-based map update (≤ 6 min). Demonstrate standard-profile upload → outline separately against the p95 ≤ 2-minute SLO; do not imply that full ingestion and media generation complete inside the 6-minute loop. The offline fallback uses the same seeded course and pre-generated assets.
- 10–20 activated pilot learners by Aug 7. Emit exactly one immutable, idempotent `pilot_activated` event per consenting non-staff/non-test learner when they complete their first text micro-lesson after submitting at least one placement answer. **D7 denominator:** activated pilots who have had seven complete rolling 24-hour periods by the Aug 15 analysis-cut timestamp. **D7 retained:** during the half-open interval from hour 144 inclusive to hour 168 exclusive after that learner's activation timestamp, either (a) a non-abstained confidently graded assessment is recorded or (b) a `study_session_completed` event records ≥ 2 minutes of foreground activity and at least one lesson/quiz action. Use elapsed UTC timestamps, not calendar days or local midnight. Deduplicate by event idempotency key; exclude seeded/staff/test accounts before denominator freeze. Consent withdrawals/deletions are removed as required by §11 and reported as a separate count and denominator change. Target ≥ 60%; always report numerator, denominator, activation range, withdrawals, and cut timestamp. The Aug 7 sprint report is provisional and includes only matured learners.
- Exploratory retention lift with a real control: among pilots whose consent version explicitly includes the experiment, randomly assign eligible weak concepts to **agent re-teach** or **simple repetition**, stratified by baseline mastery and item difficulty; administer an equivalent delayed re-test 48–72 hours later. Persist experiment/consent/assignment versions. Primary outcome is percentage-point difference in confidently graded correctness, aggregated at learner level; also report concept-level counts and learner-clustered uncertainty intervals. Target ≥ 15pp advantage, but do not claim statistical significance unless the interval and achieved sample support it. Withdrawal stops assignment and follows the analysis/deletion rules in §11.
- Architecture story told from accepted targets and evidence-backed implemented state; video is included only if the P1 flag shipped, otherwise shown as a labeled prototype/benchmark; the planned accelerator benchmark result is reported honestly

**Post-launch North Star:** *verified concepts retained per learner per week.* Supporting: activation for standard-profile sources (upload complete → first 2–3 minute text micro-lesson completed at p95 ≤ 15 min, ≥ 50% of signups), weekly active learners, spaced-rep response rate ≥ 40%, certification pass rate (long-term), consumer conversion to paid ≥ 5% at $29/mo.

---

## 13. Sprint Plan (July 17 – Aug 7)

**Pre-sprint Builder Day (Jul 16).** The planned asks were: (1) media and audio capacity approval, (2) model rate limits raised for batch generation, (3) advisory validation of the sprint vector-store decision, (4) a named contact for the accelerator benchmark track, and (5) openly licensed Alibaba Cloud ACA study materials (resolves §15 Q2). At kickoff on Jul 17, record each outcome and owner in GitHub; carry forward any unresolved quota, content, WhatsApp approval, or pilot-recruitment action rather than describing Jul 16 work as current.

**Week 1 (Jul 17–23) — Pipeline & skeleton.** Secure ingestion end-to-end with source spans, primary + fallback audio generation, authorized private-asset delivery, email auth + library UI, quiz generation v1, and one nominal 15-second source-backed video prototype behind the P1 video flag. Prepare versioned pilot consent and recruit a waitlist of 30+ candidates (target: exam date < 60 days out); no pilot activates before consent and content-rights gates pass. *Exit: the full §11 performance benchmark passes, both audio paths pass the audio gate, malformed/scanned files take their documented paths, and upload authorization/prompt-injection tests pass.*

**Week 2 (Jul 24–30) — The loop.** Knowledge model + forgetting-curve scheduling, adaptive quiz selection, executable Tutor Agent re-teach behavior, Knowledge Map UI, durable Telegram/email scheduling and delivery, privacy-safe tracing, the seeded offline bundle, and the quiz-quality, grading-accuracy, and artifact-grounding evaluations. WhatsApp remains P1. *Exit: every §11 gate marked "before pilot launch" or "blocks pilots" has passed before activation; the precise Flow B assertion passes online and offline; delivery retries/webhook replays create no duplicate attempts; then the **first 5 consented pilots go live by Jul 30** (not merely invited — D7 retention needs a week of runway before the Aug 7 metrics cut).*

**Week 3 (Jul 31–Aug 7) — Pilots & polish.** 10–20 pilot learners live; grounding, grading, quiz, and adversarial suites rerun for regression coverage and any regressions are fixed before further pilot deployment. Complete the planned accelerator benchmark with mentors, eligible readiness-score calibration, and demo hardening (offline fallbacks, seeded demo course). Voice mode remains P1 and is built only if all Week 1–2 P0 exit criteria passed on time; production 60–120 second composition and full-course video generation remain post–Demo Day fast-follow work. *Exit: all pilot-blocking gates remain green; seeded Flow B runs reliably in ≤ 6 min; the upload SLO is demonstrated separately; provisional pilot metrics report eligible cohorts and denominators.*

**Aug 8–14 — Demo Day prep.** Pitch narrative, live-demo rehearsals (≥ 10 runs), final D7 analysis at the Aug 15 cut, metrics slide with cohort dates and denominators, and failure-mode rehearsal using the seeded course and pre-generated fallback assets.

---

## 14. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Video quality/latency insufficient for the bounded prototype | Medium | Video is P1 and excluded from activation/release gates; attempt only one nominal 15-second source-backed prototype when access and capacity are authorized, label it honestly, and let audio+text carry the lesson load |
| LLM grading errors erode trust | Medium | Confidence thresholds, MC fallback, eval suite gate before pilots |
| Audio quota/capacity delays block P0 audio | Medium | Verify reserved primary capacity plus a quota-independent fallback; both must pass the §11 audio gate or Week 1 fails |
| Scope creep (7 feature groups expanding informally) | High | This PRD is the contract; anything not in §6 goes to §7 |
| Live demo or cloud dependency failure | Medium | Rehearse the explicit §9 offline envelope with the local seeded bundle; label pre-generated behavior honestly and demonstrate upload/live generation separately |
| Copyright question on stage | Low | Openly licensed demo material; §11 talking points ready |
| Retention theater (pilots sign up, don't return) | Medium | Daily messaging delivery is the hook; recruit pilots with a real exam date < 60 days out |
| WhatsApp Business approval doesn't land in time | Medium–High | Telegram is the P0 channel (no approval needed); WhatsApp is an upgrade, not a dependency — approval started Jul 16 |
| Untrusted document or unauthorized asset access | Medium | Validate and scan uploads, isolate parsers/OCR, enforce expansion/resource limits, use owner-scoped retrieval and short-lived signed URLs, and include these controls in the Week 1 exit |
| Pilot sample too small for a credible causal claim | High | Pre-register assignment and delayed-retest analysis in §12; report counts and clustered intervals; describe the 15pp target as exploratory unless achieved precision supports a stronger claim |
| Too many P0s for a 3-person team | High | Preserve P0 ingestion, audio+text, assessment, knowledge model, re-teach loop, Telegram/email delivery, and account/privacy controls. Keep video bounded to the single default-off prototype; defer production video, P1 voice, and OAuth first. Any further cut requires the human escalation process in `AGENTS.md`. |

---

## 15. Open Questions
1. Pricing test at pilot: free pilot vs. discounted paid (paid pilots = stronger Demo Day signal; decide by end of Week 2)
2. Demo certification: Alibaba Cloud ACA is the strategic pick — record the Jul 16 Builder Day licensing answer by Jul 18; fallback: an openly licensed cloud/PM guide. A human owner must approve content-rights claims before pilot use.
3. ~~Placement quiz length~~ — resolved for the sprint: 10 questions to protect activation. Revisit a 10-vs-20 experiment post-demo only if activation and evidence-quality data justify it.
4. ~~Voice tutoring live or clip~~ — resolved in F5: recorded clip unless ahead of schedule after Week 2
5. Name/trademark check: a named human owner must confirm "Reflo" clearance in US/SG before Demo Day branding and record the outcome through the `needs-human` process in `AGENTS.md`; do not treat an informal search as clearance.

---

*Owner: Founding team · Reviewers: Builder Day mentors (Alibaba Cloud, AMD) · Next revision: end of Week 1 with actuals.*
