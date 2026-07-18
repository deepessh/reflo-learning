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
| `M-001` | AnalyticDB for PostgreSQL is the sprint vector store. | `prds/reflo-prd.md` §9 | PRD revision only; discovery [#22](https://github.com/deepessh/reflo-learning/issues/22) |
| `M-002` | Every model call uses the shared, traced model-routing module; Qwen, Qwen-TTS, and flagged Wanx are routed by task. | `prds/reflo-prd.md` §9; `AGENTS.md` §5 | PRD revision only; discovery [#23](https://github.com/deepessh/reflo-learning/issues/23) |
| `M-003` | Knowledge updates use a versioned Bayesian mastery update and FSRS-style scheduling; novel psychometrics are out of scope. | `prds/reflo-prd.md` §6, F4 | PRD revision only; discovery [#24](https://github.com/deepessh/reflo-learning/issues/24) |
| `M-004` | Delivery priority is Telegram P0, opted-in email fallback, and WhatsApp P1 after approval. | `prds/reflo-prd.md` §6, F6 | PRD revision only; discovery [#25](https://github.com/deepessh/reflo-learning/issues/25) |
| `M-005` | P1 runtime surfaces are disabled behind feature flags and cannot displace P0 work. | `prds/reflo-prd.md` §6 and §13; `AGENTS.md` §5 | PRD revision only |
| `M-006` | The P0 production story uses the named Alibaba services in Singapore; offline behavior is a labeled, bounded fallback. | `prds/reflo-prd.md` §9 and §12 | PRD revision only |

The day-one GitHub bootstrap must create or reconcile closed decision issues for `M-001` through `M-004` and backfill their links here. Missing mirror issues do not weaken the underlying PRD mandates.

## Pending Decision Index

An entry in this table is not an authorized verdict. `Not opened — GitHub bootstrap pending` is permitted only until GitHub authentication and the one-time repository setup are complete.

Role names in this bootstrap inventory route ownership but do not satisfy the future issue's naming requirement. Before implementation begins, each issue must replace the role with a stable agent identity or named human DRI and must name the person or explicitly authorized group that can decide it. Missing identity is an unresolved decision, not permission to proceed.

| Key | Independently reversible choice | Decision DRI | Authorized decider | Deadline | Consequence if unresolved | Issue |
|---|---|---|---|---|---|---|
| `P-003` | Provider abstraction boundary and adapter rollout policy | Engineering lead | Founding team | 2026-07-18 | Blocks integration interfaces | [#4](https://github.com/deepessh/reflo-learning/issues/4) |
| `P-004` | IaC tool, state ownership, environment topology, secret boundary, and promotion process | Infrastructure DRI | Founding team; human approval for spending | 2026-07-18 | Blocks reproducible Singapore deployment | [#5](https://github.com/deepessh/reflo-learning/issues/5) |
| `P-005` | Email authentication mechanism/provider and session lifecycle | Application DRI | Founding team; human approval for paid service | 2026-07-18 | Blocks accounts and pilot access | [#6](https://github.com/deepessh/reflo-learning/issues/6) |
| `P-006` | Owner-scope enforcement pattern across API, database, assets, and retrieval | Security DRI | Founding team | 2026-07-19 | Blocks authorization-sensitive implementation | [#7](https://github.com/deepessh/reflo-learning/issues/7) |
| `P-007` | PDF/EPUB/DOCX parser, OCR, malware scanner, and isolated-worker runtime | Ingestion DRI | Founding team; human approval for paid service | 2026-07-19 | Blocks secure ingestion pipeline | [#8](https://github.com/deepessh/reflo-learning/issues/8) |
| `P-008` | Chunking policy, embedding model/version, and vector namespace contract | Ingestion DRI | Founding team | 2026-07-19 | Blocks source spans, embedding, and retrieval | [#9](https://github.com/deepessh/reflo-learning/issues/9) |
| `P-009` | Model-router interface, task routing, prompt registry, and tracing contract | ML platform DRI | Founding team | 2026-07-19 | Blocks all model-backed features | [#10](https://github.com/deepessh/reflo-learning/issues/10) |
| `P-010` | Quota-independent fallback TTS and common audio-asset contract | Media DRI | Founding team; human approval for spending | 2026-07-18 | Blocks the Week 1 audio gate | [#11](https://github.com/deepessh/reflo-learning/issues/11) |
| `P-011` | Event envelope, versioning, idempotency namespace, retry/DLQ policy, and finalization semantics | Platform DRI | Founding team | 2026-07-20 | Blocks durable generation and delivery | [#12](https://github.com/deepessh/reflo-learning/issues/12) |
| `P-012` | OSS/CDN object layout, authorized signing mechanism, and URL expiry | Platform DRI | Founding team | 2026-07-19 | Blocks private source and asset delivery | [#13](https://github.com/deepessh/reflo-learning/issues/13) |
| `P-013` | Feature-flag mechanism and default-off enforcement for P1 runtime surfaces | Application DRI | Founding team | 2026-07-20 | Blocks safe P1 integration | [#14](https://github.com/deepessh/reflo-learning/issues/14) |
| `P-014` | Bayesian priors, evidence mapping, confidence calculation, and reproducibility fixtures | Knowledge-model DRI | Founding team | 2026-07-24 | Blocks mastery updates and Flow B | [#16](https://github.com/deepessh/reflo-learning/issues/16) |
| `P-015` | Rubric bands, auto-grading threshold, abstention rule implementation, and FSRS grade mapping | Assessment DRI | Founding team | 2026-07-25 | Blocks grading evaluation and pilot evidence | [#17](https://github.com/deepessh/reflo-learning/issues/17) |
| `P-016` | Consent implementation, retention schedule, deletion execution, export workflow, and telemetry redaction | Privacy DRI | Named human owner | 2026-07-25 | Blocks pilot activation | [#18](https://github.com/deepessh/reflo-learning/issues/18) |
| `P-017` | Evaluation harness and dataset-versioning method for PRD §11 gates | Evaluation DRI | Founding team; human approval for content rights | 2026-07-19 | Blocks Week 1 and pre-pilot release-gate evidence | [#15](https://github.com/deepessh/reflo-learning/issues/15) |
| `P-018` | Offline bundle boundary and online/offline Flow B parity assertion | Demo DRI | Founding team | 2026-07-26 | Blocks offline Flow B | [#19](https://github.com/deepessh/reflo-learning/issues/19) |
| `P-019` | Pilot rollout controls and operational kill-switch mechanism | Platform DRI | Founding team | 2026-07-26 | Blocks safe pilot rollout | [#20](https://github.com/deepessh/reflo-learning/issues/20) |
| `P-020` | Free versus discounted paid pilot | Product DRI | Named human owner | 2026-07-30 | Keeps Stripe disabled and pilots free by default | [#21](https://github.com/deepessh/reflo-learning/issues/21) |

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

## D-GH-2 — Workspace tooling and deployable service boundaries

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owner of issue #26
- **PRD references:** `prds/reflo-prd.md` §9 and §13
- **Context and boundary:** The documentation-only repository needs one collaboration surface while preserving the PRD-mandated CDN, ECS, and Function Compute deployment targets. This verdict controls repository/package tooling and source/deployment boundaries only; adjacent database, framework, infrastructure, parser, authentication, and model-routing choices remain independently reversible decisions.
- **Options considered:** Separate repositories for each deployable; one combined deployable with later extraction; one monorepo with explicit deployable applications and shared packages.
- **Authorized verdict:** Use a single monorepo with pnpm 10.x workspaces and Turborepo 2.x, pinning exact tool versions in the scaffold. Establish independently buildable and deployable `apps/web` for the Next.js PWA, `apps/api` for the ECS API plus learner/session orchestrator, and `apps/jobs` for Function Compute handlers, alongside non-deployable shared packages. Applications may consume shared packages but may not import another application; shared packages expose deliberate public entry points and contain no deployment startup code. Keep the API and orchestrator in one ECS deployable for the sprint, permit independent handler packaging from `apps/jobs`, require no paid or remote Turborepo cache, and preserve the option to add independently deployed non-Node workers later.
- **Rationale:** A monorepo gives the three-person sprint one review surface, one lockfile, direct typed-contract sharing, and dependency-aware root commands without collapsing runtime boundaries. Separate repositories add contract-publishing and coordination overhead, while one combined deployable conflicts with independent CDN, ECS, and Function Compute build and release needs.
- **Testable consequences:** The scaffold has one pinned pnpm lockfile and pinned local Turborepo dependency; root install, dev, test, lint/format, and build commands cover all participating workspaces; `apps/web`, `apps/api`, and `apps/jobs` each build and package without importing another application; deployment artifacts can be produced independently; package-boundary checks reject app-to-app imports; governance tests remain green.
- **Reversal criteria:** Supersede this decision if measured workspace or CI overhead exceeds its coordination benefit, if deployable coupling prevents independent release, or if a required runtime cannot be supported without splitting repositories. Reversal requires a new authorized decision and merged record.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/2
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/2#issuecomment-5013334405
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/63
- **Bootstrap exception:** No

## D-GH-3 — SQL migrations, schema ownership, and write boundaries

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owner of issue #27
- **PRD references:** `prds/reflo-prd.md` §9 and §10
- **Context and boundary:** RDS PostgreSQL is the transactional system of record, while the independently deployable API and jobs must not create competing schema or write ownership. This verdict controls migrations and write access to the RDS system-of-record schema only; it does not govern the AnalyticDB vector schema or namespace contract, owner-scope/RLS policy details, deployment orchestration, or runtime query-library selection.
- **Options considered:** One application-owned plain-SQL migration stack and shared database boundary; service-owned migrations; ORM-managed schema synchronization without an explicit owner.
- **Authorized verdict:** Use dbmate as the sole migration tool for the transactional RDS PostgreSQL schema, initially pinned exactly to `dbmate@2.34.1`, with every future version exactly pinned. `packages/db` exclusively owns append-only timestamped SQL migrations, the generated checked-in `schema.sql`, and deliberate public transaction/repository entry points. Merged migrations cannot be edited, renamed, or deleted, and no ORM or query library may push or synchronize the schema. Production runs `dbmate --strict migrate` as an explicit serialized deployment operation under a DDL-capable migrator role; it never runs during application startup or Function Compute cold starts. The deployment guarantees one active runner or uses a PostgreSQL advisory-lock wrapper. Web has no database credentials; API and job runtime roles have only required DML privileges. Raw database-client use outside `packages/db` is prohibited. Independently deployed non-Node workers write through versioned, runtime-validated, language-neutral API or RocketMQ command contracts rather than directly to core RDS tables. Deployed migrations are forward-only, use expand/contract compatibility, default to transactional execution, and require explicit review for `transaction:false`.
- **Rationale:** Plain SQL preserves PostgreSQL-native constraints and features without making an ORM or one programming language the schema authority. A single shared owner keeps independently deployed runtimes consistent, while explicit serialized deployment, least-privilege roles, append-only enforcement, and expand/contract changes address dbmate's lack of content checksums and a built-in global migration lock. The boundary also keeps future non-Node workers possible without permitting competing direct-write implementations.
- **Testable consequences:** CI rejects edits, renames, or deletion of merged migrations; provisions an empty compatible PostgreSQL database; applies every migration from zero with strict ordering; explicitly runs `dbmate dump` using a pinned compatible PostgreSQL client; and fails on a `schema.sql` diff. Import checks reject raw database clients outside `packages/db`. Production runtime roles cannot execute DDL or create databases, concurrent migration attempts cannot both proceed, and old/new API and job versions remain compatible during deployment. The existing human escalation rule still governs post-activation changes to `KnowledgeState` or `Attempt`.
- **Reversal criteria:** Supersede if plain-SQL ownership creates measured delivery or safety failures, dbmate cannot support required PostgreSQL migration behavior, or the cross-runtime command boundary prevents required workload isolation. Any replacement requires a new authorized decision and merged record.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/3
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/3#issuecomment-5013417611
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/0
- **Bootstrap exception:** No
