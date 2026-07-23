# AGENTS.md — Operating Manual for Agents Building Reflo

This file covers **how to work**, not what to build. Everything product-side — features, priorities, cut order, stack decisions, quality bars, data model — lives in `prds/reflo-prd.md` (currently v1.7; the version declared in that file is authoritative). Read the PRD before your first task; re-read the relevant section before each task. If this file, `DECISIONS.md`, and the PRD conflict, the PRD wins — comment on the relevant issue or open a `decision` issue to log the conflict, and do not implement through an unresolved contradiction.

Hard deadline: sprint ends **Aug 7, 2026**; Demo Day Aug 15.

All coordination happens in **GitHub Issues** via the `gh` CLI. `DECISIONS.md` is the sole repository tracking-file exception: it is the searchable register of effective implementation and process verdicts, not a substitute task tracker. Run `scripts/doctor.sh` before setup or when command discovery changes; it checks the exact Node and pnpm pins, resolves standard `gh` install locations, distinguishes an absent command from one installed outside `PATH`, and reports whether the digest-pinned PostgreSQL client is locally available or CI-only. `scripts/work-item.sh` performs the required `gh` CLI, authentication, and read-only API preflight before its `pick` and `release` operations; do not repeat those checks manually before issue work. In a network-restricted or sandboxed execution environment, retry a helper failure that reports unavailable GitHub API access with the environment's approved network-access/escalation mechanism before diagnosing authentication. Do not ask a human to log in, refresh credentials, or replace a token based only on a sandboxed failure. Never use `--show-token` or print, persist, or paste a token while diagnosing access. If the doctor confirms that `gh` is absent rather than merely outside `PATH`, or a network-enabled run confirms that credentials are absent, invalid, or insufficiently scoped, do not claim work or create local substitute tracking; report the verified setup blocker to a human so GitHub access can be restored and the outcome recorded in the relevant issue.

---

## 1. Picking up work

1. Run `scripts/work-item.sh pick`. Do not invent `gh` claim commands, post `CLAIM:` comments, choose an issue manually, or mutate claim labels yourself.
2. The helper selects dependency-ready work from the milestone containing today's date (`W1` = Jul 17–23, `W2` = Jul 24–30, `W3` = Jul 31–Aug 7), preferring P0 over `p1` and then the lowest issue number. Outside those dates it fails so a human can identify the active queue.
3. One worktree has one deterministic `agent:wt-*` identity and at most one active claim. Every Codex task sharing that worktree shares the claim; use a separate worktree for a separate claim. `work:claimed` plus `agent:wt-*` are authoritative, and assignees are an independent availability signal that the helper never changes.
4. Finish by closing the issue, or relinquish unfinished work, then run `scripts/work-item.sh release --handoff "<what changed, exact next step, and gotchas>"`. The helper posts the durable handoff with the releasing Codex thread ID and removes the claim labels. Completed work stays claimed until its issue closes; releasing an open issue explicitly makes its unfinished work available again.
5. If work isn't an issue, it doesn't exist. Propose new work by opening an issue with a PRD-section reference and the `triage` label — a human moves it into a milestone. Whether something is in sprint scope is a PRD question (§6 vs §7); don't decide it yourself.
6. If **two distinct approaches against the same unchanged blocker** have failed, add the `blocked` label, comment what you tried and what you need, unassign yourself, and pick up something else. A materially different approach changes the mechanism or dependency being tested, not just flags or retries. Successive fixes for newly revealed independent failures do not count toward the same two-attempt threshold. Don't spin.

Dependency declarations use one exact body line: `Depends on: #12, #13`. Omit the line when no issue dependency exists. Do not put ranges or prose on that line; malformed or inaccessible dependencies fail closed.

## 2. Memory & state (how agents share context)

Agents are stateless between sessions. All durable memory lives in GitHub Issues or the code:

- **Task state & handoffs** — the issue is the memory. End every session by commenting on your assigned issue: what you did, what's half-done, exact next step, gotchas. The next agent reads the issue body, the latest handoff and subsequent comments, and linked PRs before touching anything. Link PRs with `Closes #<n>`.
- **Decisions** — `DECISIONS.md` is the searchable implementation register; GitHub issues labeled `decision` hold proposals, evidence, discussion, and authorization. Before any architectural or library choice, search the PRD mandate index and effective records in `DECISIONS.md`, then search open and closed decision issues (`gh issue list --label decision --state all --search "<topic>"`). Never duplicate an open decision or silently re-litigate an effective one.
  File-per-decision records under `docs/adrs/` are non-authoritative mirrors while `.adr-governance.yaml` is in `partial-mirror` or `complete-mirror` mode. Validate them with `python3 scripts/validate_adrs.py`; they do not replace the PRD, GitHub authorization, or `DECISIONS.md` before the separately authorized atomic cutover.
  1. Open a `decision` issue containing the context, independently reversible choice, options, recommendation, decision DRI, authorized decider, deadline, and implementation consequence. A pending index row in `DECISIONS.md` may point to it but has no implementation authority.
  2. Record the authorized verdict in an issue comment identifying the decider and approval basis. An agent may authorize its own choice only when it is outside §7, does not contradict the PRD, and the issue names the agent as authorized decider; all other choices wait for the named human.
  3. Open a PR adding an `Accepted` or `Rejected` effective record linked to the exact verdict comment. The verdict is not effective until that PR merges. A register entry without matching authorization is invalid.
  4. Close the decision issue only after the register PR merges. Semantic changes require a new decision that supersedes the old record; clarifications require a linked issue and PR.
  5. The PRD controls requirements, scope, architecture mandates, priorities, and release gates. PRD-mandated choices can be changed only by revising the PRD. Code that contradicts an effective decision is a defect.
- **Bugs & debt** — anything you notice but don't fix: open an issue labeled `bug` or `tech-debt`, one line each. Log it; don't detour.
- **Local code context** — language-appropriate `AGENT-NOTE:` comments at the spot a future agent needs them.

Do not store state in chat history, external docs, or your own head. If task state is not in an issue/PR, or an effective verdict is not in `DECISIONS.md`, it did not happen.

### Evidence-backed contributor-agent improvements

Reusable contributor-workflow improvements use the minimal protocol authorized by D-GH-83. This protocol is discovery evidence only: it never replaces immediate `bug`, `tech-debt`, `blocked`, `needs-human`, or `decision` routing, never changes claim or milestone rules, and never grants implementation or policy authority. Humans alone disposition or promote candidates, place work in milestones, authorize decisions, and change shared policy.

Open one issue with the `triage` label for a reusable improvement. The issue number is its canonical identity. The reporter chooses one unique, immutable 3–64 character lowercase kebab-case discovery key and posts the candidate marker below as the issue's first comment. The standalone marker comment must never be edited. Its `source-issue` must be a distinct issue that has been claimed through `scripts/work-item.sh`; the evidence is a 20–240 character printable-ASCII summary of the reusable workflow observation, not a task transcript or reproduction payload.

```text
<!-- reflo-improvement-candidate:v1
candidate-key: concise-discovery-alias
category: ordinary
eligibility-threshold: 2
source-issue: 42
evidence: A concise safe summary of the reusable contributor-workflow observation.
-->
```

Allowed categories are `ordinary` (threshold `2`) and `security`, `privacy`, `authorization`, `data-loss`, or `release-governance` (threshold `1`). The one-occurrence path applies only when the marker safely evidences that category; an actual vulnerability, privacy or authorization failure, data-loss risk, or release-governance defect still follows its immediate defect/escalation route and must not wait for this protocol.

For a recurrence, the observing agent posts one standalone, unedited marker on the candidate issue. The marker author owns that occurrence. `candidate-issue` is always the canonical issue number, never the discovery key. Each distinct claimed source issue may appear once across the candidate and occurrence markers; multiple observations from one task still count once.

```text
<!-- reflo-improvement-occurrence:v1
candidate-issue: 100
source-issue: 57
evidence: A concise safe summary of the independently recurring workflow observation.
-->
```

Evidence must exclude transcripts, secrets, PII, learner data, destructive live reproductions, and individual-agent rankings. Put only the minimum safe summary in the marker; keep ordinary task state in the attributed source issue. If safe evidence cannot be recorded, use the applicable immediate escalation path and do not weaken or bypass validation.

Eligibility means only that the occurrence threshold has been met for human triage. A repository maintainer records disposition with a standalone, unedited marker. `promoted` and `implemented` must name the same separate implementation or decision issue; `declined` uses `none`. The valid sequences are `promoted` → `implemented`, or `declined`.

```text
<!-- reflo-improvement-disposition:v1
candidate-issue: 100
disposition: promoted
linked-issue: 108
-->
```

Use `python3 scripts/agent_improvements.py validate`, `search [query]`, or `status <issue-number>` to inspect candidates. The helper performs read-only GitHub `GET` requests and reports canonical identity, distinct occurrence count, eligibility, and human disposition; it never creates issues or comments, changes labels or milestones, records votes, promotes work, or edits policy. A recurrence after a candidate has an `implemented` disposition and closes is a regression: open a new linked `triage` issue with its own candidate marker instead of appending evidence to the closed candidate.

## 3. Labels & milestones (the vocabulary)

| Label / milestone | Meaning |
|---|---|
| `W1` / `W2` / `W3` (milestones) | Sprint weeks per PRD §13 — only pull from the current one |
| `triage` | Proposed work, not yet accepted into a milestone. Humans triage. |
| `blocked` | Two approaches failed; needs input. Comment says what. |
| `decision` | An architectural/library/process choice being made or already made |
| `needs-human` | Escalation (see §7). Agents never resolve these. |
| `bug` / `tech-debt` | Known issues log |
| `p1` | P1-priority feature per the PRD. Consequence: ships behind a feature flag (§5) |
| `work:claimed` | Work item currently claimed through `scripts/work-item.sh` |
| `agent:wt-*` | Claim owner derived from one local Git worktree fingerprint |

Don't invent new labels. The work-item helper may create only the decision-authorized `work:claimed` and `agent:wt-*` labels; propose every other addition through a `decision` issue.

## 4. Setup & commands — keep current

> The repository is scaffolded as a pnpm/Turborepo monorepo. A stale commands section is worse than none — update it whenever a command changes.

**One-time repo init (human + first agent, day 1):**
1. Create the three milestones (`W1`, `W2`, `W3` with PRD §13 date ranges) and the labels in §3 — `gh label create` / `gh api` script them.
2. Install GitHub CLI and provision one GitHub identity per agent where possible. For a private repo, grant issue read/write plus the repository permissions needed for branches and PRs; classic tokens generally require `repo`. Verify CLI, authentication, and API access using the network-aware procedure above before seeding work. Work ownership remains worktree-scoped even when GitHub identities are distinct.
3. Reconcile the PRD mandate index in `DECISIONS.md` with closed `decision` issues for vector store and model routing (§9), plus the SR algorithm and messaging priority (§6), so both repository and GitHub searches find them. PRD mandates remain authoritative even before those issue links are backfilled.
4. File the sprint-week task issues into their milestones.

```
Doctor:       scripts/doctor.sh
Install:      corepack pnpm install --frozen-lockfile
Gov install:  python3 -m pip install --requirement scripts/requirements-governance.txt
Dev server:   corepack pnpm dev
Tests:        corepack pnpm test
Lint/format:  corepack pnpm lint / corepack pnpm format
Decisions:    python3 scripts/validate_decisions.py
ADRs:         python3 scripts/validate_adrs.py
Improvements: python3 scripts/agent_improvements.py validate
Gov tests:    python3 -m unittest scripts/test_validate_decisions.py scripts/test_validate_adrs.py scripts/test_adr_skills.py scripts/test_work_item.py scripts/test_agent_improvements.py
Pick work:    scripts/work-item.sh pick
Release work: scripts/work-item.sh release --handoff "<status and exact next step>"
Build:        corepack pnpm build
Package:      corepack pnpm package
DB migrate:   DATABASE_URL="..." corepack pnpm --filter @reflo/db db:migrate
DB snapshot:  REFLO_POSTGRES_CONTAINER_ID="..." corepack pnpm --filter @reflo/db db:dump
```

Current repo layout:

```
AGENTS.md             Agent operating manual
DECISIONS.md          Effective decision register and pending index
.github/workflows/    Repository governance and workspace CI checks
apps/                 Independently deployable web, API, and jobs applications
infra/                OpenTofu bootstrap/environment/module boundaries
packages/             Shared runtime contracts, configuration, and tool config
prds/reflo-prd.md     Product requirements and implementation source of truth
scripts/              Repository governance utilities
docs/adrs/            Non-authoritative ADR mirrors during staged coexistence
```

## 5. Code & workflow conventions

- Branches: `feat/<issue-number>-<short>`, `fix/<issue-number>-<short>`. Start each branch from freshly fetched `origin/main`. After a squash merge, never reuse or recreate the deleted feature branch for corrective work; fetch and create a new `fix/` branch from current `origin/main`. Conventional commits (`feat:`, `fix:`, `chore:`).
- Small PRs, one issue each, `Closes #<n>` in the description. Squash merge.
- Every status required by the effective GitHub ruleset must report on every pull request. Required workflows cannot use pull-request path filters or conditional required jobs; if selective work is necessary, keep an unconditional sentinel job under the required context. `.github/required-checks.json`, `scripts/check-required-checks.mjs`, and governance CI enforce workflow and live-ruleset alignment for documentation-only and code-only changes.
- Do not enable auto-merge until every expected required status is visible on the pull request and passing. If a required status fails after merge, reopen the same issue, create a corrective branch from fresh `origin/main`, link the corrective PR, and close the issue again only after the correction merges with every required status green.
- Tests required for core logic (knowledge-model math, grading, ingestion parsing); UI can be lighter.
- Generated artifacts are never hand-edited. In particular, regenerate `packages/db/schema.sql` only through `packages/db/scripts/dump-schema-from-container.sh`, using `pg_dump` from the exact digest-pinned PostgreSQL service image rather than a host client or a client that merely matches the major version.
- Turborepo uses strict environment filtering: every environment variable needed inside a task must be declared in that task's `env` or `passThroughEnv`, and a policy or integration test must prove the value reaches the task.
- Large generated-file comparisons must emit bounded diagnostics: hashes or lengths, the first differing offset, and small surrounding contexts or tails. Do not dump an entire generated artifact into CI logs.
- Every LLM call goes through the shared model-routing module with tracing — no raw API calls scattered in feature code.
- Any P1 runtime surface ships disabled behind a feature flag. Non-runtime P1 artifacts such as a recorded clip or benchmark are labeled as prototypes and are not presented as shipped functionality.
- Secrets via environment/KMS only. Never commit keys; never echo them in logs, traces, or issue comments. Never put PII in traces **or issues** — issues are the shared memory, treat them as logs.

## 6. Release gates

Before pilot activation, every PRD §11 gate marked "before pilot launch" or "blocks pilots" must pass. The seeded Flow B online/offline assertion must pass by the Week 2 exit before that adaptive loop is released to pilots. Other gates follow the timing explicitly stated in the PRD. If PRD §13 schedules pilot activation before a required §11 pre-pilot gate, treat that as an unresolved PRD conflict: add `needs-human` to the relevant issue and do not infer that the schedule waives the gate.

## 7. Escalate to humans (don't decide alone)

Open an issue (or comment on the relevant one) and add the `needs-human` label. If the escalation blocks the current issue, run the release helper with a complete handoff before picking other work. If unblocked in-scope work remains on the issue, keep the claim instead of claiming a second issue. Escalate:

- Anything touching pricing, pilot recruitment, legal/trademark, content licensing, or external comms (Alibaba/AMD/pilot users).
- Cutting, deferring, or reordering any PRD-scoped feature (milestone changes are human-only).
- Schema migrations to `KnowledgeState` or `Attempt` after pilots are live.
- Spending decisions (GPU quota, paid services).
