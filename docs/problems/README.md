# Architectural problem documents

This directory preserves broad architectural problems that should remain useful
across individual implementations. These documents collect forces, constraints,
risks, evidence needs, and open questions. They are deliberately
non-authoritative: they do not approve an architecture, restate a decision as a
new source of authority, or track delivery work.

Product requirements remain authoritative in the
[PRD](../../prds/reflo-prd.md). Accepted [ADRs](../adrs/README.md) authorize
architecture and process decisions.

## Problem index

- [Content trust, isolation, and lifecycle](content-trust-isolation-and-lifecycle.md)
- [Learning evidence integrity](learning-evidence-integrity.md)
- [Reliable progressive learning delivery](reliable-progressive-learning-delivery.md)

## Document contract

Every problem document uses the same broad sections and opens with an explicit
non-authoritative notice. It links the relevant PRD requirements and effective
decisions instead of copying their prescriptions. Problem documents contain no
status or ownership fields, assignees, milestones, task lists, delivery
sequences, recommendations framed as verdicts, or accepted/rejected decisions.
Proposals, authorization, implementation state, and handoffs stay in GitHub
Issues.

Run the repository check with:

```sh
scripts/governance-python.sh scripts/validate_problem_docs.py
```
