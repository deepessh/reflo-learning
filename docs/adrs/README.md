# Reflo architecture decision records

This directory contains one immutable, four-digit Markdown ADR per effective
architecture or process decision. In `adr-authoritative` mode, accepted ADRs
authorize decided architecture and process targets; the PRD remains
authoritative for product requirements. Rejected proposals remain in GitHub
and never become ADRs.

Validation is configured by `.adr-governance.yaml` and run with:

```sh
python3 -m pip install --requirement scripts/requirements-governance.txt
python3 scripts/validate_adrs.py
```

The validator requires exactly `PyYAML==6.0.3` and uses a duplicate-key-rejecting
subclass of PyYAML's safe loader. It parses only files named
`NNNN-lowercase-kebab-title.md`; this README is not an ADR.

## Record shape

ADR files use YAML frontmatter followed by the five lossless register sections.
Ownership is deliberately separate from authorization. This abbreviated
example documents shape only and is not an effective record:

```markdown
---
id: "0029"
title: Example decision
status: Accepted
date: "2026-07-23"
aliases: [D-GH-200]
prd_references: "`prds/reflo-prd.md` §9"
ownership:
  proposer: "@proposer"
  decision_dri: "@dri"
  implementation_owner: "Owner of issue #201"
authorization:
  decider: "@decider, authorized role"
  approval_basis: Repository owner verdict in the linked comment.
provenance:
  kind: github-decision
  issue: https://github.com/example/reflo/issues/200
  verdict_comment: https://github.com/example/reflo/issues/200#issuecomment-1
  record_pr: https://github.com/example/reflo/pull/201
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0029: Example decision

## Context

Lossless `Context and boundary` text.

## Options

Lossless `Options considered` text.

## Decision

### Authorized verdict

Lossless verdict text.

### Rationale

Lossless rationale text.

## Verification

Lossless `Testable consequences` text.

## Reversal criteria

Lossless reversal text.
```

`github-decision`, `bootstrap-exception`, and `prd-mandate` provenance have
different required fields. The three former technical PRD mandates use
`authority_state: transferred` and the exact atomic cutover PR declared in
`.adr-governance.yaml`. Lifecycle
changes retain the body and use bidirectional `supersedes`/`superseded_by`
links. Deprecation carries its own issue, exact verdict comment, date, PR,
decider, and approval basis. Marked typo, formatting, and navigation-only
maintenance is reviewable metadata; unmarked accepted-content edits fail.

The cutover contract at
`scripts/fixtures/adr-governance/cutover-contract.json` keeps the D-GH-127
retain/move boundary executable. It requires M-004 messaging priority, M-005
P1/default-off behavior, and the product portion of M-006 to remain in the PRD,
while the provider/storage portion of M-006 resolves to existing ADRs.
It also rejects moved architecture fragments that reappear in the PRD. The
contract never represents a decided target as implemented.
