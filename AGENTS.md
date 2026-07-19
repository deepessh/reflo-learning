# AGENTS.md — Operating Manual for Agents Building Reflo

This file covers **how to work**, not what to build. Everything product-side — features, priorities, cut order, stack decisions, quality bars, data model — lives in `prds/reflo-prd.md` (currently v1.6; the version declared in that file is authoritative). Read the PRD before your first task; re-read the relevant section before each task. If this file, `DECISIONS.md`, and the PRD conflict, the PRD wins — comment on the relevant issue or open a `decision` issue to log the conflict, and do not implement through an unresolved contradiction.

Hard deadline: sprint ends **Aug 7, 2026**; Demo Day Aug 15.

All coordination happens in **GitHub Issues** via the `gh` CLI. `DECISIONS.md` is the sole repository tracking-file exception: it is the searchable register of effective implementation and process verdicts, not a substitute task tracker. `scripts/work-item.sh` performs the required `gh` CLI, authentication, and read-only API preflight before its `pick` and `release` operations; do not repeat those checks manually before issue work. In a network-restricted or sandboxed execution environment, retry a helper failure that reports unavailable GitHub API access with the environment's approved network-access/escalation mechanism before diagnosing authentication. Do not ask a human to log in, refresh credentials, or replace a token based only on a sandboxed failure. Never use `--show-token` or print, persist, or paste a token while diagnosing access. If the helper reports that `gh` is missing, or a network-enabled run confirms that credentials are absent, invalid, or insufficiently scoped, do not claim work or create local substitute tracking; report the verified setup blocker to a human so GitHub access can be restored and the outcome recorded in the relevant issue.

---

## 1. Picking up work

1. Run `scripts/work-item.sh pick`. Do not invent `gh` claim commands, post `CLAIM:` comments, choose an issue manually, or mutate claim labels yourself.
2. The helper selects dependency-ready work from the milestone containing today's date (`W1` = Jul 17–23, `W2` = Jul 24–30, `W3` = Jul 31–Aug 7), preferring P0 over `p1` and then the lowest issue number. Outside those dates it fails so a human can identify the active queue.
3. One worktree has one deterministic `agent:wt-*` identity and at most one active claim. Every Codex task sharing that worktree shares the claim; use a separate worktree for a separate claim. `work:claimed` plus `agent:wt-*` are authoritative, and assignees are an independent availability signal that the helper never changes.
4. Finish by closing the issue, or relinquish unfinished work, then run `scripts/work-item.sh release --handoff "<what changed, exact next step, and gotchas>"`. The helper posts the durable handoff with the releasing Codex thread ID and removes the claim labels. Completed work stays claimed until its issue closes; releasing an open issue explicitly makes its unfinished work available again.
5. If work isn't an issue, it doesn't exist. Propose new work by opening an issue with a PRD-section reference and the `triage` label — a human moves it into a milestone. Whether something is in sprint scope is a PRD question (§6 vs §7); don't decide it yourself.
6. If **two distinct approaches** have failed, add the `blocked` label, comment what you tried and what you need, unassign yourself, and pick up something else. Don't spin.

Dependency declarations use one exact body line: `Depends on: #12, #13`. Omit the line when no issue dependency exists. Do not put ranges or prose on that line; malformed or inaccessible dependencies fail closed.

## 2. Memory & state (how agents share context)

Agents are stateless between sessions. All durable memory lives in GitHub Issues or the code:

- **Task state & handoffs** — the issue is the memory. End every session by commenting on your assigned issue: what you did, what's half-done, exact next step, gotchas. The next agent reads the issue body, the latest handoff and subsequent comments, and linked PRs before touching anything. Link PRs with `Closes #<n>`.
- **Decisions** — `DECISIONS.md` is the searchable implementation register; GitHub issues labeled `decision` hold proposals, evidence, discussion, and authorization. Before any architectural or library choice, search the PRD mandate index and effective records in `DECISIONS.md`, then search open and closed decision issues (`gh issue list --label decision --state all --search "<topic>"`). Never duplicate an open decision or silently re-litigate an effective one.
  1. Open a `decision` issue containing the context, independently reversible choice, options, recommendation, decision DRI, authorized decider, deadline, and implementation consequence. A pending index row in `DECISIONS.md` may point to it but has no implementation authority.
  2. Record the authorized verdict in an issue comment identifying the decider and approval basis. An agent may authorize its own choice only when it is outside §7, does not contradict the PRD, and the issue names the agent as authorized decider; all other choices wait for the named human.
  3. Open a PR adding an `Accepted` or `Rejected` effective record linked to the exact verdict comment. The verdict is not effective until that PR merges. A register entry without matching authorization is invalid.
  4. Close the decision issue only after the register PR merges. Semantic changes require a new decision that supersedes the old record; clarifications require a linked issue and PR.
  5. The PRD controls requirements, scope, architecture mandates, priorities, and release gates. PRD-mandated choices can be changed only by revising the PRD. Code that contradicts an effective decision is a defect.
- **Bugs & debt** — anything you notice but don't fix: open an issue labeled `bug` or `tech-debt`, one line each. Log it; don't detour.
- **Local code context** — language-appropriate `AGENT-NOTE:` comments at the spot a future agent needs them.

Do not store state in chat history, external docs, or your own head. If task state is not in an issue/PR, or an effective verdict is not in `DECISIONS.md`, it did not happen.

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
Install:      corepack pnpm install --frozen-lockfile
Dev server:   corepack pnpm dev
Tests:        corepack pnpm test
Lint/format:  corepack pnpm lint / corepack pnpm format
Decisions:    python3 scripts/validate_decisions.py
Gov tests:    python3 -m unittest scripts/test_validate_decisions.py scripts/test_work_item.py
Pick work:    scripts/work-item.sh pick
Release work: scripts/work-item.sh release --handoff "<status and exact next step>"
Build:        corepack pnpm build
Package:      corepack pnpm package
DB migrate:   Unavailable — schema issue #27 is not implemented
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
```

## 5. Code & workflow conventions

- Branches: `feat/<issue-number>-<short>`, `fix/<issue-number>-<short>`. Conventional commits (`feat:`, `fix:`, `chore:`).
- Small PRs, one issue each, `Closes #<n>` in the description. Squash merge.
- Tests required for core logic (knowledge-model math, grading, ingestion parsing); UI can be lighter.
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
