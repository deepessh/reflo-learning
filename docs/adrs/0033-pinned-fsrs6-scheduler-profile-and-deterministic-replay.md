---
id: "0033"
title: "Pinned FSRS-6 scheduler profile and deterministic replay"
status: Accepted
date: "2026-07-23"
aliases: [D-GH-152]
prd_references: "`prds/reflo-prd.md` §6 F4–F6 and §§10–13; ADR 0016; ADR 0025; ADR 0030"
ownership:
  proposer: "codex-root through issue #152"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #39"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in issue #152"
  approval_basis: >-
    direct owner approval in the Codex task on 2026-07-23 after reviewing the
    final issue-body proposal, the independent review findings, the applied
    revisions, and the final independent recommendation to approve for human
    verdict recorded in comment 5066592209.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/152
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/152#issuecomment-5066611419
  record_pr: https://github.com/deepessh/reflo-learning/pull/154
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0033: Pinned FSRS-6 scheduler profile and deterministic replay

## Context

Issue #39 must produce deterministic, versioned due schedules from eligible
per-concept Again (1) and Good (3) ratings. ADRs 0016, 0025, and 0030
intentionally leave the independently reversible FSRS implementation and
profile choice unresolved.

This decision selects the FSRS generation and implementation, exact immutable
parameters, time semantics, normalized persisted state, replay history,
delivery-time boundary, and historical replay contract. It preserves the
separation between mastery and retrievability: time, scheduling, delivery, or
override transitions never mutate Bayesian mastery or evidence strength. It
does not change grading eligibility, the ADR 0030 rating mapping, the PRD
re-teach threshold, or delivery-channel authorization.

## Options

1. Pin `ts-fsrs@5.4.1` / FSRS-6 behind a narrow scheduler port with a
   checked-in immutable sprint profile and adapter containment.
2. Implement FSRS-6 formulas locally from the published algorithm.
3. Defer scheduling and persist ratings only.

## Decision

### Authorized verdict

Accept option 1 and the complete contract below.

Package, runtime, and immutable profile:

- Pin `ts-fsrs` exactly to `5.4.1`, published npm integrity
  `sha512-mOp9+oexJexBTkwjg/jQI1aSUQRLIAvbimeKHLSmVdNJPwObugFNKmZkoggH5d6kZ0uaWLboP1Al1DnXAfIb9w==`,
  MIT license, and package identity `v5.4.1 using FSRS-6.0`. The authoritative
  scheduler runs on the repository-pinned Node `24.18.0`; a runtime change
  must pass every golden vector, and any output change requires a new profile.
- Adopt `fsrs-profile-v1` with the full 21-weight vector
  `[0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542]`;
  desired retention `0.90000`; maximum interval `36500` days; fuzz disabled;
  short-term behavior disabled; and empty learning and relearning steps.
- Pass the complete profile to `generatorParameters`, compare every resolved
  field and weight to the checked-in manifest, and fail closed on drift. Do
  not consume library defaults, optimize parameters, or admit Manual (0), Hard
  (2), or Easy (4) through the production port.
- The profile identity binds the package version and integrity, FSRS
  generation, resolved parameters, allowed ratings, timestamp rules,
  normalized-card schema, canonical serialization, and adapter-containment
  version. A change to any bound value creates a new profile.
- The exact artifact adds configurable enumerable `scheduler`, `diff`,
  `format`, and `dueFormat` properties to `Date.prototype`. The scheduler
  adapter is the sole allowed importer. It dynamically imports the package
  after snapshotting the four original descriptors, verifies the exact
  expected mutation, then restores each original descriptor or deletes the
  property when it was previously absent. It uses exported functions only and
  fails initialization on an unexpected or non-restorable mutation. Boundary
  and runtime tests reject any other import and prove no prototype addition
  remains visible after adapter initialization.

Authoritative review time and canonical evidence order:

- For sprint v1, the sole scheduler review instant is the trusted database
  `attempt.created_at` of the eligible evidence. It is server/database assigned
  when the response is accepted; provider-supplied event times are metadata
  only. Delayed callbacks therefore schedule from trusted acceptance time,
  never an untrusted claimed answer time.
- Persist the original PostgreSQL `timestamptz` and canonical-order evidence by
  full database timestamp, then lowercase canonical UUID text for `attempt.id`,
  then lowercase canonical UUID text for `concept.id`. Before calling the
  JavaScript scheduler, floor the trusted instant to Unix epoch milliseconds
  and serialize it exactly as UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`. Offsetless input
  timestamps are rejected at ingress; no process-local time zone or wall clock
  participates.
- `ts-fsrs@5.4.1` transition elapsed days are UTC calendar-date differences,
  while due instants are the review instant plus an integer multiple of
  86,400,000 milliseconds. This behavior is accepted and golden-tested: a
  UTC-midnight crossing can count as one elapsed day even after only minutes,
  while two reviews on the same UTC date count as zero.
- The unique evidence identity is
  `(owner_scope_id, attempt_id, concept_id)`. An exact duplicate is a no-op. A
  duplicate identity with any conflicting timestamp, rating, eligibility,
  user, scope, policy, or profile input fails closed. Abstained, superseded,
  ineligible, exposure, completion, engagement, or unrated evidence creates no
  scheduler transition.
- Canonical full replay is authoritative. Every admitted eligible evidence
  causes replay from an explicit empty card through all eligible evidence in
  canonical order. An implementation may use an incremental fast path only
  when it proves the new evidence sorts after the current tail and the
  resulting canonical bytes equal full replay; otherwise it runs full replay.
  Arrival order never changes state.

Immutable replay runs and normalized card state:

- Persist append-only `scheduler-replay-v1` runs. A deterministic run identity
  binds owner scope, user, concept, profile identity, and the ordered digest of
  all admitted evidence inputs. Each run has a complete ordered manifest
  covering every eligible evidence with stable evidence identity, rating,
  canonical reviewed instant, exact prior-card digest, exact next-card digest,
  and profile identity. Transition payloads are content-addressed and may be
  referenced by multiple run manifests so unchanged prefixes are not copied;
  the referenced payloads remain immutable and each run remains independently
  verifiable. Repeating an identical replay reuses the run; a conflicting run,
  manifest, or transition identity fails closed.
- A current projection may point to the latest completed valid run. During
  their authorized lifetime, prior runs and transitions are never rewritten or
  individually deleted. Authorized whole-scope demo reset or lifecycle
  deletion removes the evidence and all derived runs, transitions, projections,
  delivery resolutions, and overrides together, leaves no shadow retention,
  and is not prohibited by append-only semantics.
- A profile migration never mutates or mixes an old run. A separately
  authorized successor profile replays the immutable evidence ledger into a
  new run and, for the records' authorized lifetime, retains the old profile,
  run, transitions, and projection for historical interpretation. Whole-scope
  authorized reset or lifecycle deletion still removes both old and new
  derived records with their evidence.
- Normalize every card field rather than relying on opaque library JSON:
  `due` and nullable `last_review` as UTC millisecond instants; `stability` and
  `difficulty` as canonical decimal strings with exactly eight fractional
  digits backed by sufficient fixed-precision numeric storage; `state` as
  integer `0` (New) or `2` (Review); and `elapsed_days`, `scheduled_days`,
  `reps`, `lapses`, and `learning_steps` as non-negative integers.
  `learning_steps` is always zero. Learning (1), Relearning (3), non-finite
  numbers, negative counts, unsafe integers, excess precision, unknown fields,
  or state/profile mismatches fail closed.
- Canonical serialization is UTF-8 JSON with one specified key order, UTC
  timestamps in the exact millisecond form above, decimal strings retaining
  eight places, and integers in base-10 without leading zeros. Persist and
  verify a SHA-256 digest of each canonical prior card, next card, transition,
  and completed run. Incremental state, a fresh full replay, and repeated
  replay must be byte-equivalent at this boundary.
- The current `review_schedule` projection stores the normalized current card
  fields, profile identity, current replay-run identity, FSRS due instant,
  supplied IANA time-zone identifier, and delivery-time resolution metadata.
  Opaque `state` JSON alone is insufficient.

Delivery time, time zones, and overrides:

- Keep `fsrs_due_at` separate from `next_delivery_at`. FSRS is zone-independent
  and produces the former. `delivery-time-profile-v1` resolves the latter from
  the learner's chosen `HH:mm` local wall time, with seconds zero, in the
  validated supplied IANA zone. For each candidate local date, enumerate every
  valid instant for that wall time and select the minimum instant greater than
  or equal to `fsrs_due_at`; if no candidate qualifies, advance one local
  calendar date and repeat.
- Start with the local calendar date containing `fsrs_due_at`. For a DST fold,
  evaluate both occurrences and choose the earlier one only when both qualify;
  if `fsrs_due_at` lies between them, choose the later occurrence. For a DST
  gap, move the nonexistent wall time forward by the transition gap while
  preserving minutes, then apply the same greater-than-or-equal test; if that
  shifted instant does not qualify, advance to the next local date. Persist the
  chosen local time, IANA identifier, resolved UTC instant, disambiguation
  result, and authoritative tzdb version. The sprint runtime is Node `24.18.0`
  with tzdb `2026b`; tzdb/runtime changes require the delivery vectors to pass
  and stored historical resolutions remain immutable.
- A learner time-zone or chosen-time change affects only future delivery
  resolutions and never FSRS memory, historical runs, evidence, or mastery.
- Manual and policy reschedules do not use the library's Manual rating and do
  not alter FSRS card memory or `fsrs_due_at`. They create an append-only typed
  delivery override with stable identity, trusted creation instant, one closed
  reason (`user_snooze`, `reteach_follow_up`, `channel_unavailable`, or
  `operator_demo_control`), absolute `deliver_not_before_at`,
  actor/authorization provenance, and causal reference. Exact duplicate
  overrides are no-ops; conflicts fail closed. Canonical override order is
  trusted creation instant then override UUID. The effective
  `next_delivery_at` is the maximum of the base delivery resolution and every
  active override's `deliver_not_before_at`, so creating an override can only
  move delivery later. Cancellation is a new append-only
  `override_cancelled` event that targets exactly one override identity; it
  deactivates only that override and recomputes the maximum. Cancellation may
  move delivery earlier than the prior overridden projection but never earlier
  than the base resolution or any remaining active override. No source event
  is rewritten.

Forgetting-state and mastery boundary:

- `KnowledgeState.half_life` remains null in v1. FSRS stability is the interval
  at the profile's reference retrievability, not a literal half-life, and must
  never be copied into that field. The normalized FSRS card and derived
  retrievability are the versioned forgetting state. Any future true-half-life
  projection requires a separately versioned, explicitly rounded derivation.
- Scheduler replay, delivery resolution, profile replay, and overrides never
  change Bayesian alpha/beta, mastery, evidence strength, mastery review count,
  or assessment status. Only ADR 0016-eligible scored evidence changes mastery.

### Rationale

The maintained TypeScript implementation is compatible with the pinned runtime
and avoids inventing sprint psychometrics. Exact pinning, an explicit fully
resolved profile, trusted timestamp normalization, canonical full replay,
immutable run history, normalized fixed representations, prototype
restoration, fuzz-off behavior, and golden vectors prevent dependency defaults,
arrival order, wall-clock behavior, runtime serialization, or delivery policy
from silently changing schedules. Disabling short-term steps matches the
product's daily-review surface. Separating FSRS due time, delivery time, and
delivery overrides satisfies F6 without pretending that an IANA zone changes
the forgetting curve.

## Verification

This decision blocks only the scheduler transition/profile portion of #39.
Append-only learning events, immutable evidence normalization, and
`knowledge-model-v1` replay may proceed. The matching Accepted ADR must merge
before #39 adds the dependency, scheduler schema, transition code, or
delivery-time projection. The implementation may change the pre-pilot
`review_schedule` schema to satisfy the normalized projection and immutable
replay-run contract.

- Golden cards cover New and Review states; Again and Good only; complete
  prior/next normalized cards; exact new-card vectors; Good→Again versus
  Again→Good at one instant; UTC-midnight and same-UTC-date elapsed-day
  behavior; long intervals and the maximum cap; and exact numeric/timestamp
  serialization.
- Replay tests cover same-time UUID tie ordering, out-of-order arrival,
  incremental-versus-full replay, replay-run reuse, conflicting duplicate
  rejection, concurrent admission, profile-version replay without mutation,
  historical run retention, content-addressed prefix reuse, and bounded
  storage/replay workload at the maximum supported evidence count per concept.
  A naive representation that exceeds the recorded bound is not acceptable.
- Boundary tests prove abstained, superseded, ineligible, exposure, engagement,
  Hard, Easy, and Manual inputs create no production transition;
  scheduler-only actions cause zero mastery change; and `half_life` remains
  null.
- Package tests verify npm integrity, exact resolved parameters, fuzz absence,
  Node-runtime golden parity, sole-import enforcement, exact `Date.prototype`
  mutation detection, successful descriptor restoration, and no remaining
  enumerable or own-property additions.
- Delivery tests cover due-at equality, chosen time before/after due, IANA
  validation, UTC and non-UTC zones, DST gap and fold resolution under tzdb
  2026b, zone/preference changes, later-only overrides, cancellation events,
  and zero FSRS/mastery mutation.
- Ten repeated full replays of each golden ledger must produce identical
  canonical bytes and SHA-256 digests.

## Reversal criteria

Supersede when representative rights-authorized review history supports
optimized parameters or retention; the package, runtime, or prototype
containment cannot preserve deterministic replay; measured workload or latency
makes full replay or immutable runs infeasible; tzdb/profile pinning cannot
preserve chosen-time delivery; or a future product requirement authorizes
short-term steps or more rating bands. Any successor preserves immutable
evidence during its authorized lifetime, authorized whole-scope
reset/lifecycle deletion without shadow retention, historical profile
interpretation while records remain authorized, deterministic replay, the
mastery/retrievability boundary, and separate FSRS/delivery time semantics.
