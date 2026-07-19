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
| `M-006` | The P0 production story uses the named Alibaba services; offline behavior is a labeled, bounded fallback. | `prds/reflo-prd.md` §9 and §12 | PRD revision only |

The day-one GitHub bootstrap must create or reconcile closed decision issues for `M-001` through `M-004` and backfill their links here. Missing mirror issues do not weaken the underlying PRD mandates.

## Pending Decision Index

An entry in this table is not an authorized verdict. `Not opened — GitHub bootstrap pending` is permitted only until GitHub authentication and the one-time repository setup are complete.

Role names in this bootstrap inventory route ownership but do not satisfy the future issue's naming requirement. Before implementation begins, each issue must replace the role with a stable agent identity or named human DRI and must name the person or explicitly authorized group that can decide it. Missing identity is an unresolved decision, not permission to proceed.

| Key | Independently reversible choice | Decision DRI | Authorized decider | Deadline | Consequence if unresolved | Issue |
|---|---|---|---|---|---|---|
| `P-005` | Email authentication mechanism/provider and session lifecycle | Application DRI | Founding team; human approval for paid service | 2026-07-18 | Blocks accounts and pilot access | [#6](https://github.com/deepessh/reflo-learning/issues/6) |
| `P-007` | PDF/EPUB/DOCX parser, OCR, malware scanner, and isolated-worker runtime | Ingestion DRI | Founding team; human approval for paid service | 2026-07-19 | Blocks secure ingestion pipeline | [#8](https://github.com/deepessh/reflo-learning/issues/8) |
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

Trademark clearance, content-rights evidence, quotas, provider privacy-setting verification, recruitment, and external contacts are human gates or operational evidence rather than reusable implementation decisions. Keep them in the relevant `needs-human` issues; an effective decision may link to safe, non-sensitive evidence when it materially supports a verdict.

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
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/64
- **Bootstrap exception:** No

## D-GH-4 — Provider capability ports and adapter rollout

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owners of the integration implementation issues, beginning with issue #28
- **PRD references:** `prds/reflo-prd.md` §9 and §13
- **Context and boundary:** Reflo must integrate model, media, storage, delivery, and observability providers without spreading vendor SDKs through feature code or weakening the named Alibaba P0 production path. This verdict controls the shared provider-adapter boundary, activation eligibility, configuration, and cross-capability rollout rules only; capability-specific behavior remains independently reversible in its owning decision.
- **Options considered:** Narrow capability ports with thin provider adapters; one universal provider SDK wrapper; direct vendor SDK calls from feature/domain code.
- **Authorized verdict:** Use narrow capability ports with thin provider adapters. Shared capability packages own provider-independent Reflo contracts, deterministic fakes, and reusable conformance suites. Only adapter modules may import vendor SDKs or types; composition roots import public adapter factories and select from an explicit allowlist using validated configuration, while feature/domain code never names providers. Adapters normalize failures and expose only allowlisted sanitized diagnostics. Adapters are unavailable by default until common conformance, adapter-specific translation/redaction, target-environment integration, and all applicable security, privacy, provider-setting, quota/capacity, feature, consent, and quality gates are current. Unknown, disabled, or no-longer-approved selections fail closed. Each operation uses exactly one approved adapter; rollback chooses another currently approved configuration or disables the capability. Fallback is capability-specific, implemented by the owning router/policy outside adapters and provider-agnostic callers, and permitted only when the PRD or an effective decision authorizes it under the same applicable gates. It may not weaken privacy or owner-scope controls, bypass P1 gates, violate delivery priority, or replace the named Alibaba P0 production path. Do not build a universal provider wrapper or runtime plugin registry.
- **Rationale:** Small capability contracts preserve service-specific semantics while providing deterministic tests, explicit activation, controlled fallback, and replaceable implementations. A universal wrapper would either leak vendor details or reduce distinct model, storage, messaging, and observability services to a weak common denominator; direct SDK calls would scatter policy and make offline/testing paths inconsistent.
- **Testable consequences:** Import-boundary checks reject vendor SDK access outside adapters and provider branching in feature/domain packages. Common conformance suites run against deterministic fakes and every adapter, while adapter-specific tests cover translation and diagnostic redaction. Configuration fails closed for unknown, disabled, or stale adapters; rollout never shadow-sends learner data or duplicates messages/assets/authoritative writes; authorized fallback preserves the capability contract and applicable gates. Decisions #10 through #13 retain model-routing, TTS, event/retry, and OSS/CDN details; #14 retains P1 flag enforcement and #20 retains pilot rollout and kill switches.
- **Reversal criteria:** Supersede if measured adapter overhead blocks sprint delivery, capability contracts cannot express required provider semantics without pervasive escape hatches, or the boundary prevents a mandatory integration. Any replacement must preserve the PRD's model-routing, security, privacy, testing, and named P0 production-path requirements.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/4
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/4#issuecomment-5013547754
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/65
- **Bootstrap exception:** No

## D-GH-5 — OpenTofu infrastructure, environment, secret, and promotion controls

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owner of issue #26 for the initial repository and CI surface; cloud-resource implementation requires a separately triaged issue and assigned owner
- **PRD references:** `prds/reflo-prd.md` §9, §11, and §13
- **Context and boundary:** Reflo needs reproducible Alibaba Cloud infrastructure, isolated development, staging, and pilot environments, repository-owned state custody, KMS-backed runtime secrets, and evidence-bearing promotion without long-lived CI credentials. This verdict controls the IaC tool, remote-state and environment boundaries, infrastructure identities, secret-payload boundary, promotion evidence, drift handling, and infrastructure recovery. It does not authorize spending, replace feature-specific provider decisions, change the PRD-mandated Alibaba P0 production path, or make provider-specific resources portable without migration work.
- **Options considered:** OpenTofu or Terraform CLI with self-managed remote state; native or hosted Terraform through Alibaba Resource Orchestration Service; documented manual provisioning; managed Alibaba IaC Service as a future alternative if its controls and coverage are verified.
- **Authorized verdict:** Use OpenTofu CLI with the official Alibaba Cloud provider as the sole IaC path, initially pinning OpenTofu `1.12.0` and `aliyun/alicloud` `1.283.0` exactly and committing the dependency lock file. Use one `infra/bootstrap` root and explicit `dev`, `staging`, and `pilot` roots; do not use workspaces for environment isolation. Store distinct environment state in a private, versioned, encrypted OSS backend with TableStore locking and tightly restricted plan, apply, and break-glass access. Separate environments by state, resource groups and tags, networks, RAM roles, KMS secret namespaces, data stores, buckets, queues, logs, and service identities; pilot has no dependency on lower environments. KMS Secrets Manager is the sole runtime secret store, plaintext payloads never enter source, tfvars, plans, logs, outputs, issues, or long-lived CI configuration, and web receives no cloud or database credentials. GitHub Actions exchanges repository- and environment-bound OIDC tokens for short-lived Alibaba STS credentials; PR workflows can validate and plan but not apply. Dev applies a fresh exact plan after merge under a concurrency lock; staging requires dev evidence and environment approval; pilot additionally requires the exact approved plan digest, staging evidence, current PRD gates, and named-human approval. Changed plans require reapproval, spending remains human-approved, and every apply records immutable version, actor, approval, change, migration, smoke, drift, and rollback evidence. Application deployables and dbmate migration retain the D-GH-2 and D-GH-3 boundaries. Application rollback selects a known-good immutable artifact; infrastructure recovery uses reviewed roll-forward or a new reviewed rollback plan. Unknown environments, stale approvals or gates, unexplained drift, lock failure, and unapproved spending fail closed. OpenTofu provides workflow portability only: a future provider switch still requires cloud-specific modules, state and data migration, testing, and any required PRD revision.
- **Rationale:** OpenTofu preserves an open, reviewable, exact-pinned workflow and a cleaner future control-plane exit than ROS while satisfying the current Alibaba production mandate. Its built-in OSS backend supports TableStore locking, the official Alibaba provider covers the required service families and OIDC role assumption, and the modest bootstrap burden is acceptable for the sprint. Native ROS adds proprietary template coupling, hosted ROS Terraform requires coverage verification, and manual provisioning cannot satisfy reproducibility or drift control. Provider-specific resources remain intentionally explicit rather than hidden behind a speculative multi-cloud abstraction.
- **Testable consequences:** CI rejects unpinned core, provider, or external module versions; unreviewed lock-file changes; committed state, plan, or secret files; non-bootstrap local backends; and workspaces used as environment boundaries. Lock contention prevents concurrent mutation. Role tests prove PR jobs cannot mutate, runtime roles cannot read state, web has no cloud or database credential, and one environment cannot access another. Promotion tests reject non-main pilot applies, mismatched or stale plan digests, missing staging evidence, stale gates, unexplained drift, and unapproved spend. Completion requires a no-op post-apply plan plus recorded commit, artifact, plan, version, approver, actor, schema, smoke, drift, and rollback evidence. Recovery documentation covers bootstrap migration, state restore, force-unlock, secret rotation, failed applies, application rollback, and infrastructure roll-forward.
- **Reversal criteria:** Supersede if the official provider lacks a PRD-required resource, OSS and TableStore locking proves unreliable, OpenTofu compatibility blocks delivery, or managed Alibaba IaC Service or ROS measurably reduces operational risk without weakening review, state custody, identity, secret, portability, or promotion gates. A cloud-provider switch also requires provider-specific replacement modules and, while M-006 remains, a PRD revision.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/5
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/5#issuecomment-5013676908
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/66
- **Bootstrap exception:** No

## D-GH-7 — Layered owner-scope enforcement

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owners of authorization-sensitive implementation issues; issue #27 owns the initial RDS schema surface
- **PRD references:** `prds/reflo-prd.md` §9, §10, and §11
- **Context and boundary:** Every course and source must be isolated by owner scope, with active membership enforced before retrieval, mutation, asset signing, vector operations, and cached responses. This verdict controls the non-bypassable authorization contract across application guards, RDS data access, jobs, caches, asset-signing entry points, vector adapters, and server-resolved citations. It does not choose the physical vector namespace or index layout, OSS key layout or signing technology, URL expiry or invalidation, session mechanics, queue-envelope structure, deletion-role workflow, or migration-role ownership; those remain with issues #9, #13, #6, #12, #18, and D-GH-3 respectively.
- **Options considered:** Application authorization guards only; database row policies only; layered application authorization plus database and provider-boundary enforcement.
- **Authorized verdict:** Adopt layered owner-scope enforcement. The server derives the actor and target scope from authenticated identity and persisted resource relationships; client, model, cache, or queue values are never authority. Typed application guards check active membership at the point of every retrieval, mutation, asset-signing request, vector operation, and cached response. RDS runtime access uses transaction-local actor and scope context that fails closed when absent. Runtime roles are not table owners, superusers, or granted `BYPASSRLS`; row-level security and database-enforced scoped relationships independently prevent cross-scope reads, writes, and links. During MVP only personal user scopes may be created, each active user scope has exactly one active owner membership, and organization scopes and non-owner roles remain disabled. Jobs reauthorize membership and resource ownership before privileged access; caches are scope-keyed and reauthorized before return. Asset signing accepts only server-resolved authorized resources and never arbitrary caller-supplied object keys. Vector adapters require a non-removable owner scope for every write, update, search, and result-validation path. Uploaded or retrieved source text cannot influence authorization or filters, and displayed citations resolve server-side only to currently authorized source spans.
- **Rationale:** Application guards express action-level policy and produce clear failures, but omissions in API or job code must not expose data. RLS and scoped relationships provide an independent RDS backstop, while explicit cache, signing, vector, and citation boundaries cover stores PostgreSQL cannot protect. Transaction-local context prevents pooled connections from leaking authorization state across requests, and least-privilege runtime roles keep the database backstop effective.
- **Testable consequences:** Tests reject forged scope IDs, absent authorization context, revoked membership at point of use, zero or multiple active owners during a normal active user-scope lifecycle, cross-scope direct and multi-hop relationships, pooled-connection context reuse, cache leakage, tampered job messages, arbitrary or cross-scope asset references, missing or replaced vector filters, cross-scope vector writes or results, unauthorized source-span citations, and direct cross-scope access by runtime database roles. Application-guard and RLS conformance tests cover the same access matrix without assuming either layer replaces the other. Remaining validity of an already issued signed URL follows issue #13 rather than this verdict.
- **Reversal criteria:** Supersede if the layered contract cannot meet required latency or deployment behavior, PostgreSQL RLS cannot be operated safely with the selected connection and role model, or an alternative provides equivalent independently enforced isolation across every covered store with lower measured risk. Any replacement must preserve the PRD owner-scope, active-membership, untrusted-content, and zero-cross-scope-disclosure requirements.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/7
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/7#issuecomment-5014469215
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/69
- **Bootstrap exception:** No

## D-GH-9 — Versioned source-span, embedding, and vector-namespace contract

- **Status:** Accepted
- **Decision date:** 2026-07-19
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Owners of the secure-ingestion, vector-adapter, source-span, and grounded-retrieval implementation issues
- **PRD references:** `prds/reflo-prd.md` §6 F1, §9, §10, and §11; mandate M-001
- **Context and boundary:** Reflo needs reproducible source spans, embeddings, retrieval, owner isolation, re-indexing, and deletion behavior in the PRD-mandated AnalyticDB for PostgreSQL store. This verdict controls canonical chunk boundaries and locators, embedding identity and drift handling, the logical and physical vector-namespace layout, exact and approximate search activation, embedding-generation lifecycle, and vector deletion behavior. It does not revisit the AnalyticDB mandate, choose parsers or isolated-worker technology, define general provider-adapter or authorization architecture, authorize a reranker or sparse-vector path, or replace the PRD's grounding, privacy, deletion, and performance gates; those remain with M-001, issues #8 and #10, D-GH-4, D-GH-7, and the PRD.
- **Options considered:** Fixed token windows; hierarchical chapter/section parent-child chunks; deterministic structure-aware bounded semantic leaf chunks. Physical per-owner schemas/tables versus a shared contract-versioned table with logical owner namespaces. Provider-managed automatic chunking/embedding versus a Reflo-owned versioned contract. Exact search only versus benchmark-gated HNSW activation.
- **Authorized verdict:** Adopt `chunk-v1`, `embedding-v1`, and `vector-namespace-v1`. `chunk-v1` deterministically packs canonical parsed blocks within one logical section toward approximately 450 tokens, merges fragments below approximately 150 tokens when possible without crossing sections, treats page boundaries as locators rather than mandatory splits, uses no overlap normally and at most one sentence or 64 tokens only when splitting an oversized semantic block, preserves lists and tables under the limit, and caps the complete submitted embedding input—including breadcrumbs, overlap, and repeated table headers—at 700 tokens under a named versioned tokenizer. Canonical source text is unchanged text from the versioned normalized parse; citations resolve only from that text through ordered page/section mappings and half-open canonical offsets. Persist parser, chunker, tokenizer, embedding-input-profile, locator, and text-hash provenance and derive stable span IDs from the source document, contract versions, ordered locators, and text hash. `embedding-v1` uses Alibaba Model Studio `text-embedding-v4`, dense 1024-dimensional vectors, cosine distance, `text_type=document` for source spans, and `text_type=query` for queries; it adds no custom instruction without a frozen evaluation. Persist the region/endpoint, provider identifier and available response metadata, dimensions, input mode and profile, input hash, request ID, timestamps, and outcome. Frozen embedding/retrieval canaries detect provider-alias drift; announced or detected behavior changes create a new evaluated profile and generation, and different profiles never share an index. Within each physically isolated environment, `vector-namespace-v1` is the logical `(environment, owner_scope_id)` namespace in one shared contract-versioned AnalyticDB table/collection rather than per-learner schemas, tables, or indexes. Every key and uniqueness constraint begins with non-null `owner_scope_id`; vector operations accept a server-issued authorization context and must constrain and revalidate owner scope, source-document status, active generation, and non-deleted retention state before canonical text enters model context. Exact cosine search is the sprint default. HNSW requires a frozen benchmark showing material latency benefit, recall@10 of at least 0.98 against exact search, correct filtered behavior without scoped under-return, and no scope or generation contamination; it must use cosine and may not initially use product quantization. Each rebuild creates an immutable generation stored under `(owner_scope_id, source_span_id, embedding_generation_id)`, builds and validates side-by-side, and atomically changes the authoritative RDS active-generation pointer at the source-document level; failure leaves the old generation active. Chunk-policy changes create new spans, embedding-only changes reuse spans, and superseded vectors retire only after the rollback window. Deletion synchronously makes the owner/source non-retrievable in RDS, requires retrieval-time authorization and retention rechecks, and asynchronously purges every vector generation with retries and audit evidence within the PRD's 24-hour requirement; rollback and fallback cannot bypass tombstones.
- **Rationale:** Structure-aware bounded chunks preserve semantic units and citation precision without the duplicate storage and two-stage retrieval complexity of hierarchical parent-child indexing. The current Alibaba guidance recommends `text-embedding-v4` and 1024 dimensions for general-purpose text retrieval, while explicit input and generation profiles make a mutable provider alias testable. A shared table keeps schema, index, migration, deletion, and re-index operations bounded; the logical owner namespace plus D-GH-7's mandatory server-resolved scope enforcement prevents cross-scope access without relying on dynamic per-learner database objects. Exact search gives deterministic full recall for the small pilot corpus, while evidence-gated HNSW preserves a safe performance path as the corpus grows.
- **Testable consequences:** Deterministic PDF, EPUB, and DOCX fixtures prove canonical offsets, page/section mappings, stable IDs, complete provenance, section isolation, table/list behavior, and the full-input hard cap. Contract tests reject missing or forged authorization contexts, omitted or replaced filters, cross-scope batch writes, searches, and deletes, stale or deleted sources, inactive generations, contaminated results, dimension or metric mismatches, and query/document input-mode errors. Frozen canaries detect embedding behavior drift. Re-index tests cover idempotent side-by-side builds, completeness, no-orphans, activation, failure, rollback, and retirement. Deletion tests deny retrieval synchronously and purge every generation without resurrection. HNSW remains unavailable until filtered exact-versus-approximate recall, under-return, grounding, contamination, and latency fixtures satisfy the authorized activation criteria.
- **Reversal criteria:** Supersede if measured retrieval quality requires hierarchical or differently bounded chunks, `text-embedding-v4` cannot meet grounding or operational gates, provider alias drift cannot be detected reliably, the shared-table scope contract cannot preserve zero cross-scope disclosure, or exact/HNSW behavior cannot meet the required recall and latency envelope. Any replacement must preserve stable source provenance, owner-scoped fail-closed retrieval, generation-safe re-indexing, deletion across all generations, the PRD grounding and privacy gates, and M-001 unless the PRD itself changes.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/9
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/9#issuecomment-5015788306
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/72
- **Bootstrap exception:** No

## D-GH-67 — Worktree-based issue pickup and claim labels

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** codex-root
- **Decision DRI:** @deepessh
- **Authorized decider:** @deepessh, repository owner and founding-team decider named in the originating issue
- **Implementation owner:** Repository governance maintainers and agents using the work-item helper
- **PRD references:** `prds/reflo-prd.md` §9 and §13
- **Context and boundary:** Comment-authoritative claims are hard to scan and require each agent to reconstruct ownership and ordering manually. This verdict controls repository issue pickup, claim identity, dependency-ready selection, concurrency handling, and release handoffs only; it does not change product scope, milestone membership, implementation priority, decision authority, or the PRD sprint schedule.
- **Options considered:** Retain comment-authoritative claims; use claim labels through hand-written GitHub commands; use one repository helper with worktree-scoped identity and label-authoritative claims.
- **Authorized verdict:** Use `scripts/work-item.sh pick` and `scripts/work-item.sh release --handoff <message>` as the only supported claim interface. Generate and cache one deterministic `agent:wt-*` identity per Git worktree, permit at most one claim per worktree, and represent ownership with `work:claimed` plus that agent label without mutating assignees. The helper selects from the current sprint milestone, excludes assigned, claimed, `blocked`, and `needs-human` issues, requires every canonical `Depends on: #N, #M` dependency to be closed, prefers issues without `p1`, and then chooses the lowest issue number. Worktree-local locking serializes local callers; concurrent worktrees add both labels, resolve the winner from the earliest active agent-label event with event ID as the tie-breaker, and make losers remove only their own label before retrying. Every release requires an idempotent handoff, appends the releasing `CODEX_THREAD_ID` or `unavailable`, removes the shared claim label before the agent label, and clears local current-issue state last. Codex task IDs provide handoff attribution only and never define claim ownership.
- **Rationale:** A small checked-in helper makes the common workflow discoverable and testable while labels make availability visible in GitHub. Worktree identity matches the shared branch and index that constrain concurrent implementation, avoids one label per Codex task, and still records the releasing task in the durable handoff. Exact dependency syntax and fail-closed parsing avoid interpreting prose as scheduling authority.
- **Testable consequences:** Agents do not post claim or withdrawal comments or issue hand-written claim API calls. One worktree cannot claim two issues even with simultaneous callers; separate worktrees deterministically resolve collisions; assigned, unavailable, human-only, blocked, malformed, inaccessible, and dependency-blocked work is skipped; P0-ready work precedes `p1`; missing local current-issue state recovers only from one unambiguous remote claim; repeated release after a partial failure posts one handoff per claim generation and leaves no ambiguous availability window. Governance CI runs Bash syntax checks and mocked GitHub integration tests.
- **Reversal criteria:** Supersede if GitHub label/event semantics cannot provide reliable ownership, worktree identity causes duplicate or stranded claims, dependency declarations cannot remain canonical, or maintaining the helper costs more coordination time than the comment protocol it replaces.
- **Supersedes:** None
- **Issue:** https://github.com/deepessh/reflo-learning/issues/67
- **Verdict:** https://github.com/deepessh/reflo-learning/issues/67#issuecomment-5013820162
- **Pull request:** https://github.com/deepessh/reflo-learning/pull/68
- **Bootstrap exception:** No
