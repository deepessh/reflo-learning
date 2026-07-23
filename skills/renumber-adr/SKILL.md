---
name: renumber-adr
description: Detect and resolve Reflo ADR number collisions for unmerged draft ADRs by checking the local branch, target branch, and open pull requests, then updating draft filenames, Reflo IDs and headings, supersession links, generated tables, alias mappings, and mutable references. Use before merging a Reflo ADR PR, after another ADR PR takes the same number, or whenever an ADR draft collision is suspected. Never use for merged or accepted ADR history.
---

# Renumber Reflo ADR Drafts

Renumber only branch-added ADR drafts whose provisional IDs collide with the
target branch or another open PR. Preserve all merged decision history.

## Check before changing files

1. Read D-GH-125, D-GH-126, `.adr-governance.yaml`, and
   `docs/adrs/README.md`.
2. Fetch the PR target and confirm the local target ref is current.
3. Run the collision check without `--apply`:

```sh
python3 skills/renumber-adr/scripts/renumber_adr.py \
  --target-ref origin/main --base-branch main
```

Exit `0` means no collision. Exit `2` prints a deterministic rename plan without
changing files. Exit `1` means the script could not prove the operation safe.
Do not bypass a fail-closed result.

The script queries the current PR state and every open PR targeting the same
base. It refuses closed or merged current PRs, detached or ambiguous branch
state, malformed ADR paths, duplicate local IDs, unavailable target refs, and
unavailable or malformed GitHub data.

## Apply the plan

Review the dry-run JSON, then apply the same inventory:

```sh
python3 skills/renumber-adr/scripts/renumber_adr.py \
  --target-ref origin/main --base-branch main --apply
```

The script assigns the lowest unused four-digit IDs and updates:

- branch-added ADR filenames;
- Reflo frontmatter `id` and `# ADR NNNN: Title` headings;
- unambiguous draft-to-draft `supersedes` and `superseded_by` links;
- new legacy-alias entries on the branch;
- exact draft-filename links, generated tables, and mutable references.

It leaves merged ADR files, SQL files, migration directories, and other
historical provenance untouched and reports protected references that remain.
When a bare canonical reference could mean the target ADR rather than the
colliding draft, retain it instead of guessing.

## Non-negotiable limits

- Never rename an ADR path present on the target ref.
- Never renumber a merged record, even for ordering or aesthetics.
- Never reuse or delete a permanent legacy alias.
- Never rewrite immutable migrations or historical provenance comments.
- Never change decision semantics while renumbering.
- Preserve the filename slug; change only its four-digit prefix.
- Stop for manual review when references are ambiguous.

## Validate

After applying, inspect the diff and run:

```sh
python3 scripts/validate_adrs.py --base-ref origin/main
python3 -m unittest scripts/test_adr_skills.py scripts/test_validate_adrs.py
```

Then run repository lint and tests required by `AGENTS.md`.

## Source inspiration

This is an original, fail-closed Reflo implementation. The three-source
collision pattern was informed by Fullsend's pinned
[`renumber-adr`](https://github.com/fullsend-ai/fullsend/blob/4e23848d09c02be88d9a09c6d074476a643044da/skills/renumber-adr/SKILL.md)
skill and its
[`inflight-adr-numbers.sh`](https://github.com/fullsend-ai/fullsend/blob/4e23848d09c02be88d9a09c6d074476a643044da/skills/renumber-adr/scripts/inflight-adr-numbers.sh)
helper. Reflo's immutable IDs, exact authority, protected-history rules, and
validator take precedence.
