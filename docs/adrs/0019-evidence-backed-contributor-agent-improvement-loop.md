---
id: "0019"
title: "Evidence-backed contributor-agent improvement loop"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-83]
prd_references: "`prds/reflo-prd.md` §13 and opening “Ways of working” declaration"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of the separate implementation issue that depends on issue #83, with repository governance maintainers reviewing the policy and tooling changes"
authorization:
  decider: "@deepessh, repository owner"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/83
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/83#issuecomment-5019262163
  record_pr: https://github.com/deepessh/reflo-learning/pull/87
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0019: Evidence-backed contributor-agent improvement loop

## Context

Reusable contributor-agent improvements currently appear only in individual task handoffs or ordinary bug, debt, and decision issues, making recurrence and promotion evidence difficult to discover consistently. This verdict controls only how contributor agents record, discover, validate, and escalate reusable workflow-improvement candidates. It does not change product scope, architecture mandates, priorities, release gates, issue-pickup ownership, existing defect and escalation duties, decision authority, or human milestone authority; D-GH-81 remains related toolchain and CI-recovery policy rather than authorization for this broader protocol.

## Options

Keep the current ad hoc handoff and ordinary-issue approach; adopt one minimal evidence-backed GitHub candidate protocol with read-only validation, search, and status tooling; build an automated learning system that creates issues, records votes, promotes candidates, or edits shared policy.

## Decision

### Authorized verdict

Adopt the minimal evidence-backed agent improvement loop. Record one `triage` candidate issue per reusable improvement, with the GitHub issue number as canonical identity and a reporter-selected immutable candidate key used only as a discovery alias. The reporter owns the initial candidate marker and key; an agent recording a later occurrence owns its reproduction marker and must tie that evidence to the distinct claimed source issue where it occurred. Count at most one evidence-backed occurrence per distinct claimed source issue. An ordinary candidate becomes eligible for human triage after two such occurrences; a safely evidenced security, privacy, authorization, data-loss, or release-governance candidate is immediately eligible after one occurrence. Eligibility is evidence, not implementation authority. Humans alone disposition candidates and control promotion, milestones, decisions, and policy changes through the existing issue workflow; candidates cannot create new obligations without a separate conforming decision issue and effective record when required. V1 tooling is a read-only Python validator and search/status helper: it never creates issues, posts comments, changes labels or milestones, records votes, promotes work, or edits policy. GitHub Issues remain the sole durable coordination memory. Candidate evidence must exclude task transcripts, secrets, PII, learner data, destructive live reproductions, and individual-agent rankings. Actual bugs, debt, blockers, and human escalations follow their existing rules immediately and never wait for a recurrence threshold. Later recurrence of a closed implemented candidate routes to a linked `triage` regression issue.

### Rationale

Distinct claimed issues provide an auditable occurrence identity without counting repeated discussion or retries inside one task as independent evidence. A two-occurrence default filters one-off friction, while one safely evidenced critical occurrence avoids delaying security and release-governance improvements. Immutable discovery keys support deterministic search without replacing GitHub issue identity, and a read-only helper makes validation and status visible while preserving human authority and the existing GitHub-centered workflow.

## Verification

A separate implementation issue depends exactly on #83 and owns the marker schemas, `AGENTS.md` protocol, read-only Python helper, mocked GitHub tests, and unconditional governance-CI coverage. Validation rejects mutable or duplicate candidate identities, unsupported or unsafe evidence, duplicate counting from one source issue, missing claimed-source attribution, and thresholds inconsistent with this verdict. Search and status output deterministically identify canonical candidates, occurrence counts, eligibility, and human disposition without mutating GitHub. Tests prove the helper performs no write API calls and cannot create issues, comments, labels, milestones, votes, promotions, or policy edits. Review confirms ordinary defects and escalations retain their existing immediate paths and that no candidate or eligible status is treated as implementation authority.

## Reversal criteria

Supersede if the protocol creates more contributor overhead than reusable value, distinct claimed issues do not provide a reliable occurrence identity, candidate aliases cause ambiguity despite canonical issue numbers, the thresholds systematically delay material improvements or admit excessive noise, read-only tooling cannot validate the protocol without fragile GitHub coupling, or human triage cannot keep eligible candidates current. Any replacement must preserve GitHub as durable coordination memory, immediate defect and escalation handling, safe evidence rules, human promotion and milestone authority, and decision-record authorization for new policy obligations.
