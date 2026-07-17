# Reflo Decision Register

This file is the canonical, version-controlled register of effective implementation and process verdicts. It is not a task tracker and does not replace the product requirements in `prds/reflo-prd.md`.

## Authority and lifecycle

- The PRD controls product requirements, scope, architecture mandates, priorities, and release gates. It wins over contradictory issues, decision records, external forms, and code.
- GitHub issues labeled `decision` hold proposals, evidence, discussion, and authorization. Proposal text lives in GitHub rather than being duplicated here.
- A GitHub verdict becomes effective only when the matching record is merged into this file. A record without matching authorization is invalid, and an issue verdict without a merged record is not yet effective.
- Pending rows below are a discovery index only and have no implementation authority.
- Code that contradicts an effective record is a defect.
- A PRD mandate can be changed only through a PRD revision. An effective decision can change only through a new record that supersedes it.
- Decision IDs normally use the originating issue number (`D-GH-<issue-number>`), are immutable, and are never reused.

### Decision workflow

1. Open one GitHub `decision` issue for one independently reversible choice. Name the proposer, decision DRI, authorized decider, deadline, implementation consequence, options, and recommendation.
2. Record the authorized verdict in an issue comment that identifies the decider and approval basis.
3. Open a PR that adds an `Accepted` or `Rejected` record linked to the exact verdict comment.
4. Confirm that the record matches the verdict and does not conflict with the PRD, then merge it.
5. Close the issue only after the register PR merges. Semantic changes require a new superseding record; clarifications require a linked issue and PR.

### Bootstrap exception

The repository owner explicitly authorized the initial decision-system change on July 17, 2026 without a GitHub issue because GitHub authentication was unavailable. The exception is limited to `AGENTS.md`, PRD §9, this file, `scripts/validate_decisions.py`, and the decision-validation CI workflow. It does not authorize application work or future issue-free decisions. `D-BOOTSTRAP-001` records that verdict.

## PRD Mandate Index

These entries improve discovery; they are not ordinary decision records and cannot be superseded through this register.

| Mandate | Fixed choice | Authoritative source | Change control |
|---|---|---|---|
| `M-001` | AnalyticDB for PostgreSQL is the sprint vector store. | `prds/reflo-prd.md` §9 | PRD revision only |
| `M-002` | Every model call uses the shared, traced model-routing module; Qwen, Qwen-TTS, and flagged Wanx are routed by task. | `prds/reflo-prd.md` §9; `AGENTS.md` §5 | PRD revision only |
| `M-003` | Knowledge updates use a versioned Bayesian mastery update and FSRS-style scheduling; novel psychometrics are out of scope. | `prds/reflo-prd.md` §6, F4 | PRD revision only |
| `M-004` | Delivery priority is Telegram P0, opted-in email fallback, and WhatsApp P1 after approval. | `prds/reflo-prd.md` §6, F6 | PRD revision only |
| `M-005` | P1 runtime surfaces are disabled behind feature flags and cannot displace P0 work. | `prds/reflo-prd.md` §6 and §13; `AGENTS.md` §5 | PRD revision only |
| `M-006` | The P0 production story uses the named Alibaba services in Singapore; offline behavior is a labeled, bounded fallback. | `prds/reflo-prd.md` §9 and §12 | PRD revision only |

The day-one GitHub bootstrap must create or reconcile closed decision issues for `M-001` through `M-004` and backfill their links here. Missing mirror issues do not weaken the underlying PRD mandates.

## Pending Decision Index

An entry in this table is not an authorized verdict. `Not opened — GitHub bootstrap pending` is permitted only until GitHub authentication and the one-time repository setup are complete.

Role names in this bootstrap inventory route ownership but do not satisfy the future issue's naming requirement. Before implementation begins, each issue must replace the role with a stable agent identity or named human DRI and must name the person or explicitly authorized group that can decide it. Missing identity is an unresolved decision, not permission to proceed.

| Key | Independently reversible choice | Decision DRI | Authorized decider | Deadline | Consequence if unresolved | Issue |
|---|---|---|---|---|---|---|
| `P-001` | Workspace/package tooling and deployable service boundaries | Engineering lead | Founding team | 2026-07-18 | Blocks application scaffold | Not opened — GitHub bootstrap pending |
| `P-002` | SQL migration tool, schema ownership, and cross-language write boundary | Engineering lead | Founding team | 2026-07-18 | Blocks database scaffold and worker contracts | Not opened — GitHub bootstrap pending |
| `P-003` | Provider abstraction boundary and adapter rollout policy | Engineering lead | Founding team | 2026-07-18 | Blocks integration interfaces | Not opened — GitHub bootstrap pending |
| `P-004` | IaC tool, state ownership, environment topology, secret boundary, and promotion process | Infrastructure DRI | Founding team; human approval for spending | 2026-07-18 | Blocks reproducible Singapore deployment | Not opened — GitHub bootstrap pending |
| `P-005` | Email authentication mechanism/provider and session lifecycle | Application DRI | Founding team; human approval for paid service | 2026-07-18 | Blocks accounts and pilot access | Not opened — GitHub bootstrap pending |
| `P-006` | Owner-scope enforcement pattern across API, database, assets, and retrieval | Security DRI | Founding team | 2026-07-19 | Blocks authorization-sensitive implementation | Not opened — GitHub bootstrap pending |
| `P-007` | PDF/EPUB/DOCX parser, OCR, malware scanner, and isolated-worker runtime | Ingestion DRI | Founding team; human approval for paid service | 2026-07-19 | Blocks secure ingestion pipeline | Not opened — GitHub bootstrap pending |
| `P-008` | Chunking policy, embedding model/version, and vector namespace contract | Ingestion DRI | Founding team | 2026-07-19 | Blocks source spans, embedding, and retrieval | Not opened — GitHub bootstrap pending |
| `P-009` | Model-router interface, task routing, prompt registry, and tracing contract | ML platform DRI | Founding team | 2026-07-19 | Blocks all model-backed features | Not opened — GitHub bootstrap pending |
| `P-010` | Quota-independent fallback TTS and common audio-asset contract | Media DRI | Founding team; human approval for spending | 2026-07-18 | Blocks the Week 1 audio gate | Not opened — GitHub bootstrap pending |
| `P-011` | Event envelope, versioning, idempotency namespace, retry/DLQ policy, and finalization semantics | Platform DRI | Founding team | 2026-07-20 | Blocks durable generation and delivery | Not opened — GitHub bootstrap pending |
| `P-012` | OSS/CDN object layout, authorized signing mechanism, and URL expiry | Platform DRI | Founding team | 2026-07-19 | Blocks private source and asset delivery | Not opened — GitHub bootstrap pending |
| `P-013` | Feature-flag mechanism and default-off enforcement for P1 runtime surfaces | Application DRI | Founding team | 2026-07-20 | Blocks safe P1 integration | Not opened — GitHub bootstrap pending |
| `P-014` | Bayesian priors, evidence mapping, confidence calculation, and reproducibility fixtures | Knowledge-model DRI | Founding team | 2026-07-24 | Blocks mastery updates and Flow B | Not opened — GitHub bootstrap pending |
| `P-015` | Rubric bands, auto-grading threshold, abstention rule implementation, and FSRS grade mapping | Assessment DRI | Founding team | 2026-07-25 | Blocks grading evaluation and pilot evidence | Not opened — GitHub bootstrap pending |
| `P-016` | Consent implementation, retention schedule, deletion execution, export workflow, and telemetry redaction | Privacy DRI | Named human owner | 2026-07-25 | Blocks pilot activation | Not opened — GitHub bootstrap pending |
| `P-017` | Evaluation harness and dataset-versioning method for PRD §11 gates | Evaluation DRI | Founding team; human approval for content rights | 2026-07-25 | Blocks release-gate evidence | Not opened — GitHub bootstrap pending |
| `P-018` | Offline bundle boundary and online/offline Flow B parity assertion | Demo DRI | Founding team | 2026-07-26 | Blocks offline Flow B | Not opened — GitHub bootstrap pending |
| `P-019` | Pilot rollout controls and operational kill-switch mechanism | Platform DRI | Founding team | 2026-07-26 | Blocks safe pilot rollout | Not opened — GitHub bootstrap pending |
| `P-020` | Free versus discounted paid pilot | Product DRI | Named human owner | 2026-07-30 | Keeps Stripe disabled and pilots free by default | Not opened — GitHub bootstrap pending |

Activation, D7, experiment, readiness, and numerical release-gate semantics are already fixed by the PRD. Track their implementation in ordinary issues unless a genuinely unresolved, independently reversible choice emerges.

Trademark clearance, content-rights evidence, quotas, provider-region verification, recruitment, and external contacts are human gates or operational evidence rather than reusable implementation decisions. Keep them in the relevant `needs-human` issues; an effective decision may link to safe, non-sensitive evidence when it materially supports a verdict.

## Effective Decision Records

Only `Accepted`, `Rejected`, and `Superseded` records belong in this section.

## D-BOOTSTRAP-001 — Repository decision authority and register

- **Status:** Accepted
- **Decision date:** 2026-07-17
- **Proposer:** Repository owner
- **Decision DRI:** Repository governance
- **Authorized decider:** Repository owner, through the explicit bootstrap instruction recorded in this change
- **Implementation owner:** Initial governance-change implementer
- **PRD references:** `prds/reflo-prd.md` §9
- **Context and boundary:** GitHub-only decision history is difficult to discover as a coherent architectural record, while a file-only process lacks the discussion, approval, and coordination trail required by `AGENTS.md`. This verdict controls implementation/process decision governance; it does not change product requirements.
- **Options considered:** GitHub issues as the sole source; `DECISIONS.md` as the sole source; GitHub authorization plus a merged repository register.
- **Authorized verdict:** The PRD controls product requirements and mandates. GitHub decision issues control proposal, evidence, discussion, and authorization. An authorized verdict becomes effective and searchable only when its matching record is merged into `DECISIONS.md`. Code and implementation issues must conform to both the PRD and effective records.
- **Rationale:** The split preserves GitHub's audit and coordination strengths while making effective verdicts reviewable in one version-controlled location.
- **Testable consequences:** `AGENTS.md`, PRD §9, and this file state the same authority model; future non-bootstrap effective records link to an issue, exact verdict comment, and merged PR; decision issues close only after the register change merges; pending entries are never implementation authority.
- **Reversal criteria:** Replace only if the workflow creates measurable coordination failure or tooling cannot keep issue authorization and the merged register consistent. Any replacement requires a new authorized record and corresponding PRD/AGENTS updates.
- **Supersedes:** None
- **Issue:** None — one-time bootstrap exception authorized by the repository owner
- **Verdict:** Repository owner directive dated 2026-07-17, durably recorded by this entry
- **Pull request:** Current bootstrap change; replace with the merged PR URL when GitHub access is restored
- **Bootstrap exception:** Yes — limited to the files listed in the Bootstrap exception section
