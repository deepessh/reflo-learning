---
id: "0042"
title: "Deferred release qualification activation and retained v2 evidence"
status: Accepted
date: "2026-07-27"
aliases: [D-GH-202]
prd_references: "`prds/reflo-prd.md` v2.7 §3 G1 and G5, §6 F1 and F2, §7, §8 Flow A, and §§9, 11–14; ADR 0005; ADR 0008; ADR 0015; ADR 0034; ADR 0035; ADR 0041"
ownership:
  proposer: "@deepessh through issue #202"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #198 and owners of the retained release-qualification harness, attestation index, secure-ingestion environment, and future activation work"
authorization:
  decider: "@deepessh, repository owner and named founding-team product and architecture decider"
  approval_basis: >-
    in the current Codex task the owner explicitly directed, “Also Close 100
    and 107 and update the prd, record an adr as required,” after reviewing the
    drafted PRD v2.7 deferral. The durable product and closure boundary is
    recorded in #198 comment 5098629609.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/202
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/202#issuecomment-5098633820
  record_pr: https://github.com/deepessh/reflo-learning/pull/201
supersedes: ["0041"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0042: Deferred release qualification activation and retained v2 evidence

## Context

PRD v2.7 prioritizes deployment and hardening of the complete
staff-controlled connected application and moves formal target-production
performance, dual-TTS, upload-security, adversarial-document, and
secure-ingestion environment qualification after Demo Day. The connected
seeded Flow B, separate staff-controlled PDF upload observation, secure
ingestion behavior, explicit dependency failures, rights-cleared sources,
staff-only identities and messaging destinations, and prohibitions on public
or real-user use remain in force.

ADR 0041 made the PDF-only v2 evaluation, evidence, scorer, and attestation
family authoritative for Demo release gates. Leaving that activation wording
current would make the repository appear to require formal qualification
before the staff-controlled Demo Day deployment, contrary to PRD v2.7.
Deleting or weakening the v2 family would destroy useful future verification
capability and blur the distinction between deferring a gate and passing it.

This decision controls only activation and consumption of the retained formal
qualification profiles through Demo Day, the classification of deployment and
smoke evidence, and the preservation of v2 verification capability. It does
not change product scope or SLO targets; alter dataset eligibility, schemas,
scoring, evidence immutability, or attestation meaning; weaken secure-ingestion
runtime controls; authorize a corpus, deployment, paid capacity, public use,
external learner data or messaging, pilot activation, or a
production-readiness claim; or make a deferred qualification pass.

## Options

Retain the v2 architecture under a successor ADR while making formal
qualification inactive through Demo Day; rely only on PRD precedence while
leaving ADR 0041's Demo-gate activation wording current; or remove or weaken
the harness, fixtures, attestation index, and secure-ingestion controls
together with the sprint deferral.

## Decision

### Authorized verdict

Adopt `release-qualification-activation-v1`.

Formal target-production performance, dual-TTS, upload-security,
adversarial-document, and secure-ingestion environment qualification are
inactive as sprint, deployment, promotion, and Demo Day prerequisites through
August 15, 2026. The staff-controlled connected application may be deployed
and demonstrated without current passing attestations for those formal
profiles. Missing, stale, failed, indeterminate, or not-run evidence never
becomes a pass; it is simply not an active prerequisite inside this bounded
Demo Day profile.

Retain `evaluation-contract-v2`, `dataset-manifest-v2`,
`evidence-bundle-v2`, `release-gate-scorer-v2`, and
`gate-attestation-v2` as one non-composable future qualification family.
Retain the trusted attestation index, immutable v1 and v2 history, exact PRD
mapping, repository ownership, rights and privacy restrictions, frozen
membership and digests, deterministic scoring, human-review authority,
target-bound execution, content-addressed evidence, dependency currentness,
storage separation, deletion applicability, and fail-closed interpretation
adopted by ADRs 0015 and 0041. Results and attestations from different
contract families still never aggregate. No schema, dataset, evidence,
scorer, attestation, or historical record changes meaning under this
activation decision.

Keep the v2 performance dataset PDF-only and keep the explicit early-rejection
routes for EPUB and DOCX in upload-security evidence. Internal EPUB and DOCX
parser fixtures remain inactive fast-follow architecture regression coverage,
not product support or performance evidence.

Development integration, deployment smoke checks, connected rehearsals, a
single observed staff-controlled upload, and other bounded operational checks
remain useful defect evidence. They cannot publish or imply a passing formal
qualification, establish p95 or capacity claims, or authorize production or
pilot readiness. Demo artifacts report exact observed outcomes and identify
formal profiles as not run, incomplete, failed, or deferred as applicable.

Secure product behavior remains mandatory independently of formal
qualification activation. PDF admission stays fail-closed for type, malware,
encryption, size and page limits; parser and OCR execution retain the accepted
networkless, credential-free, bounded isolation; owner-scope and private-asset
delivery remain enforced; dependency preflight and failures remain explicit;
and no unavailable dependency is converted into a fabricated success.

ADR 0034's connected online scope remains active. Its separate
standard-profile upload demonstration is now an exact observed timing under
PRD v2.7, not a qualified p95 result. The seeded online Flow B and its
six-minute demonstration assertion remain required and are not one of the
formal profiles deferred by this decision.

Close issues #100 and #107 after this ADR and PRD v2.7 become effective.
Their closure records state that the formal environment and release
qualification work was human-directed to post–Demo Day, did not pass, and
remains represented by the retained contracts, fixtures, evidence, and issue
history. Closing those issues is scope disposition, not verification evidence.

Reactivating any retained formal profile as a deployment, promotion, release,
pilot, or feature prerequisite requires later product authority defining its
applicability and a successor ADR defining the activation consequence. At that
time, ADR 0015 and ADR 0041's fail-closed evidence rules apply: missing,
malformed, unauthorized, mismatched, expired, deleted, failed, indeterminate,
or unverifiable evidence evaluates false.

### Rationale

Separating capability from activation lets the team focus the sprint on the
staff-controlled connected application without deleting hard-won verification
work or pretending that deferred gates passed. Preserving exact contract and
historical meaning keeps future qualification reproducible. Keeping secure
runtime behavior independent of formal environment attestation avoids turning
a schedule decision into a security-control waiver.

An explicit later activation step prevents stale or incomplete evidence from
silently becoming a prerequisite or a pass. Exact observation labeling keeps
the Demo Day story honest while preserving the product's post–Demo Day
qualification targets.

## Verification

ADR validation proves ADR 0041 is superseded by this record and this record is
the active authority for the v2 qualification family. The architecture view
and evaluation guide identify the v2 family as retained, inactive future
verification capability and link to this ADR. PRD v2.7 identifies all five
formal profiles as post–Demo Day and prohibits p95, capacity, security,
production-readiness, or pilot claims from staff-controlled demonstration or
smoke evidence.

Existing v1/v2 schema, scorer, publisher, attestation-index, database,
historical-immutability, cross-version rejection, rights, privacy,
determinism, bounded-diagnostic, and fail-closed tests remain unchanged and
green. Existing secure-ingestion, PDF-only admission, unsupported EPUB/DOCX,
network and credential denial, owner-scope, cleanup, dependency-failure, and
Flow B tests remain green. No test or migration rewrites a retained artifact
or converts absent evidence into `passed`.

Issues #100 and #107 close only after the record PR merges with every required
status green. Their final comments identify the owner-directed deferral, link
PRD v2.7 and this ADR, preserve exact future work and evidence references, and
state that neither formal qualification passed.

## Reversal criteria

Supersede when post–Demo Day product authority activates one or more retained
formal qualification profiles; changes their product applicability, targets,
or support boundary; or replaces the v2 family with a new semantic contract.
Any successor must preserve immutable historical meaning, prevent
cross-version aggregation, retain repository ownership and rights/privacy
controls, require target-bound deterministic evidence for active profiles,
keep secure runtime controls independent of gate timing, and prohibit
deployment or smoke observations from becoming formal passes.
