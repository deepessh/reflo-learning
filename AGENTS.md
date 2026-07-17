# AGENTS.md — Operating Manual for Agents Building Reflo

This file covers **how to work**, not what to build. Everything product-side — features, priorities, cut order, stack decisions, quality bars, data model — lives in `prds/reflo-prd.md` (currently v1.6; the version declared in that file is authoritative). Read the PRD before your first task; re-read the relevant section before each task. If this file, `DECISIONS.md`, and the PRD conflict, the PRD wins — comment on the relevant issue or open a `decision` issue to log the conflict, and do not implement through an unresolved contradiction.

Hard deadline: sprint ends **Aug 7, 2026**; Demo Day Aug 15.

All coordination happens in **GitHub Issues** via the `gh` CLI. `DECISIONS.md` is the sole repository tracking-file exception: it is the searchable register of effective implementation and process verdicts, not a substitute task tracker. Before issue work, run `gh --version` and `gh auth status`. If `gh` is missing or unauthenticated, do not claim work or create local substitute tracking; report the setup blocker to a human so GitHub access can be restored and the outcome recorded in the relevant issue.

---

## 1. Picking up work

1. Work = open issues in the current sprint milestone: `W1` = Jul 17–23, `W2` = Jul 24–30, and `W3` = Jul 31–Aug 7 (PRD §13). Substitute the milestone containing today's date: `gh issue list --milestone "<current-milestone>" --no-assignee --state open`. Outside those dates, do not infer a current milestone; ask a human which queue is active.
2. Claim by comment first; assignment only mirrors the winning claim:
   - Confirm the issue has no assignee and no existing winning `CLAIM:` comment.
   - Post `CLAIM: <stable-agent-name>`. Do not put a client-generated timestamp in the body.
   - Re-fetch all `CLAIM:` and `WITHDRAW CLAIM:` comments. A claim is active until a later withdrawal by the same stable agent name. The earliest active claim in GitHub's server-side chronological order wins; if timestamps tie, the smaller GitHub issue-comment database ID wins. Later claimants post `WITHDRAW CLAIM: <stable-agent-name>` and choose another issue. A claim posted while an earlier claim remains active never displaces it.
   - With distinct GitHub identities, the winner runs `gh issue edit <n> --add-assignee @me`, then verifies it is the sole assignee with `gh issue view <n> --json assignees`. With a shared bot identity, the winning comment is authoritative because assignment cannot identify the agent.
   - Re-check the winning claim and assignment immediately before creating the branch. Never work an issue whose winning claim belongs to another agent.
3. One active claim per agent. Before claiming, verify that the same stable agent name has no other active claim. Close the issue (or leave a status comment, withdraw the claim, and remove your assignment when identities are distinct) before claiming another.
4. If work isn't an issue, it doesn't exist. Propose new work by opening an issue with a PRD-section reference and the `triage` label — a human moves it into a milestone. Whether something is in sprint scope is a PRD question (§6 vs §7); don't decide it yourself.
5. If **two distinct approaches** have failed, add the `blocked` label, comment what you tried and what you need, unassign yourself, and pick up something else. Don't spin.

**Identity requirement:** distinct GitHub users are preferred because assignments remain useful. With a shared bot token, `@me` is identical for all agents, so use stable agent names and treat the server-ordered claim comments—not assignment—as the ownership record.

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

Don't invent new labels; propose them via a `decision` issue.

## 4. Setup & commands — keep current

> The repository is currently documentation-only and has not been scaffolded. The owner of the scaffold issue must replace the unavailable entries below in the same PR that introduces each command. A stale commands section is worse than none — update it whenever a command changes.

**One-time repo init (human + first agent, day 1):**
1. Create the three milestones (`W1`, `W2`, `W3` with PRD §13 date ranges) and the labels in §3 — `gh label create` / `gh api` script them.
2. Install GitHub CLI and provision one GitHub identity per agent where possible. For a private repo, grant issue read/write plus the repository permissions needed for branches and PRs; classic tokens generally require `repo`. Confirm `gh --version` and `gh auth status` before seeding work. If identities must share a bot, use the comment-claim protocol in §1.
3. Reconcile the PRD mandate index in `DECISIONS.md` with closed `decision` issues for vector store and model routing (§9), plus the SR algorithm and messaging priority (§6), so both repository and GitHub searches find them. PRD mandates remain authoritative even before those issue links are backfilled.
4. File the sprint-week task issues into their milestones.

```
Install:      Unavailable — application not scaffolded
Dev server:   Unavailable — application not scaffolded
Tests:        Unavailable — application not scaffolded
Lint/format:  Unavailable — application not scaffolded
Decisions:    python3 scripts/validate_decisions.py
Gov tests:    python3 -m unittest scripts/test_validate_decisions.py
DB migrate:   Unavailable — application not scaffolded
```

Current repo layout:

```
AGENTS.md             Agent operating manual
DECISIONS.md          Effective decision register and pending index
.github/workflows/    Repository governance checks
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

Open an issue (or comment on the relevant one) and add the `needs-human` label. If the escalation blocks the current issue, leave a handoff/status comment, withdraw the claim, remove your assignment when identities are distinct, and only then pick up other work. If unblocked in-scope work remains on the issue, keep the claim and continue it instead of claiming a second issue. Escalate:

- Anything touching pricing, pilot recruitment, legal/trademark, content licensing, or external comms (Alibaba/AMD/pilot users).
- Cutting, deferring, or reordering any PRD-scoped feature (milestone changes are human-only).
- Schema migrations to `KnowledgeState` or `Attempt` after pilots are live.
- Spending decisions (GPU quota, paid services).
