# Reflo release-gate evaluation

`@reflo/evaluation` implements the repository-owned `evaluation-contract-v2`
defined by ADR 0041 / D-GH-196. It validates immutable dataset manifests,
enforces the retained qualification profiles, deterministically scores
performance, dual-TTS, upload-security, and adversarial runs, emits
content-addressed evidence bundles, and publishes fail-closed
environment-scoped attestations through an authorized index port.

PRD v2.7 defers formal target-environment execution until after Demo Day. The
v2 contracts, schemas, fixtures, scorers, historical evidence, and attestation
index remain inactive future verification capability; they are not deleted,
weakened, or represented as passed. The retained performance contract is
PDF-only: every standard-profile item is a 5–200 page PDF between 0.5 and
20 MiB. Passing it does not provide EPUB or DOCX support, performance, or SLO
evidence. Upload security still requires explicit fail-closed rejection
coverage for EPUB and DOCX at the PDF-only product boundary.

CI may validate schemas, fixtures, determinism, and fail-closed behavior. It
cannot pass the performance, audio, upload-security, adversarial-document, or
secure-ingestion environment gates. Those require the deferred target
execution and current rights, capacity, quota, legal, human-listening, and
other operational evidence required by the PRD.

After building the package, evaluate an immutable input without overwriting an
existing bundle:

```sh
corepack pnpm --filter @reflo/evaluation build
corepack pnpm --filter @reflo/evaluation evaluate -- input.json bundle.json
```

The CLI prints only a bounded GitHub-safe summary. Authoritative bundles belong
in the private evaluation-evidence store, not the client-delivery bucket or a
GitHub comment.
