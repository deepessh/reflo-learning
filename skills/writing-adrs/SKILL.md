---
name: writing-adrs
description: Create or update authoritative Reflo Architecture Decision Records under docs/adrs using the repository's GitHub authorization, provenance, schema, allocation, lifecycle, and document-authority rules. Use when an accepted Reflo decision needs an ADR record or when target-architecture and problem-document references must be updated after an ADR is accepted.
---

# Write Reflo ADRs

Create one Reflo-governed decision record without weakening GitHub authorization,
PRD product authority, ADR authority, or accepted-record immutability.

## Establish authority first

1. Read `AGENTS.md`, the relevant PRD section and accepted ADRs,
   `.adr-governance.yaml`, and `docs/adrs/README.md`.
2. Read the decision issue and exact verdict comment.
3. Require one standalone owner-authored verdict that says `Accepted`, identifies
   the authorized decider, and states the approval basis. Verify the comment URL
   and author association with `gh`; do not infer approval from reactions,
   discussion, issue closure, or a bare earlier `Accepted` comment.
4. Stop without creating an effective ADR when the verdict is absent, rejected,
   non-owner-authored, inexact, or inconsistent with the PRD or accepted ADRs.
5. Rejected proposals remain in GitHub and never produce ADR files. An accepted
   verdict becomes effective only when its authorized ADR PR merges.

## Allocate a draft number

Fetch the target branch, then run:

```sh
python3 skills/writing-adrs/scripts/allocate_adr_number.py \
  --target-ref origin/main --base-branch main
```

The allocator inspects reserved IDs, local ADRs, the target ref, and added or
renamed ADR paths in every other open PR. It excludes the current open PR,
returns the lowest unused four-digit ID, and fails closed if GitHub, Git, config,
or collision state is uncertain. Treat allocation as provisional until merge.

## Write the record

1. Create `docs/adrs/NNNN-lowercase-kebab-title.md`.
2. Copy the Reflo shape from `docs/adrs/README.md`; do not substitute another
   ADR template.
3. Preserve `Context and boundary`, `Options considered`, `Authorized verdict`,
   `Rationale`, `Testable consequences`, and `Reversal criteria` losslessly in
   the corresponding Reflo sections.
4. Keep ownership separate from authorization. Use only the validator-supported
   `github-decision`, `bootstrap-exception`, or `prd-mandate` provenance shape.
5. For `github-decision`, use the originating issue, exact owner verdict comment,
   and record PR URL. If the PR does not exist yet, create a draft PR from a
   preparatory commit, then replace the temporary record-PR value before asking
   for review; never merge or call the record effective with a placeholder.
6. Add the permanent legacy alias mapping to `.adr-governance.yaml`. Preserve
   historical `D-BOOTSTRAP-001`, `D-GH-*`, and `M-*` aliases.
7. Use `Accepted`, `Deprecated`, and `Superseded` exactly as defined by
   D-GH-125. Add bidirectional supersession links. Require separate,
   owner-authorized deprecation provenance.
8. Never edit accepted semantic content. Use a successor ADR for clarification,
   reversal, or replacement; limit maintenance to marked typo, formatting, or
   navigation corrections.

## Update descriptive documents

Update `docs/architecture.md` when present so its target-architecture view links
to the active ADR without restating the decision. Update an affected broad
problem document surgically when the ADR resolves or narrows its exploration.
Keep architecture and problem documents non-authorizing: do not add verdicts,
owners, statuses, task lists, or milestones. Keep tasks and proposals in GitHub.

Do not rewrite immutable SQL migrations, historical provenance comments, or
accepted ADR filenames. Do not represent an accepted-but-unbuilt target as
implemented state.

## Validate

Install the exact governance dependency when needed, then run:

```sh
python3 -m pip install --requirement scripts/requirements-governance.txt
python3 scripts/validate_adrs.py --base-ref origin/main
python3 -m unittest scripts/test_validate_adrs.py scripts/test_adr_skills.py
```

Verify exact GitHub provenance and run repository lint and tests required by
`AGENTS.md`.

## Source inspiration

This is an original Reflo workflow. Its concise record-writing and concurrent
number-check concepts were informed by Fullsend's pinned
[`writing-adrs`](https://github.com/fullsend-ai/fullsend/blob/4e23848d09c02be88d9a09c6d074476a643044da/skills/writing-adrs/SKILL.md)
skill; Reflo's schema, authority, provenance, lifecycle, and validation rules
control here.
