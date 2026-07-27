# `@reflo/ingestion`

Trusted supervision and isolation contracts for `isolated-ingestion-v1`.

The package validates PDF/EPUB/DOCX uploads before parser execution, rejects
MIME/signature/container disagreement, encrypted or active content, unsafe XML,
and archive expansion hazards, requires a verified ClamAV snapshot no older
than 24 hours, and launches the parser through a digest-pinned rootless Podman
image with no network, capabilities, inherited container environment, writable
root, host socket, or service identity. The worker result is accepted only when
it satisfies `normalized-document-v1`, including exact parser/config/classifier
versions, native locators, text hashes, a digest-pinned worker image, bounded
diagnostics, and the `scan-detect-v1` candidate-page classification.

The Demo Day product surface admits only the configured, human-approved PDF.
EPUB and DOCX parsing remains inactive groundwork behind the internal
`isolated-ingestion-v1` boundary for post–Demo Day fast-follow work. Keeping
their parser and contract fixtures does not advertise those formats as
Demo Day-supported, and the demo API must reject them before quarantine or
processing.

`IngestionSupervisor` is intentionally composed from narrow ports:

- `IngestionOperationStore` owns authorization rechecks and D-GH-12 claim/CAS
  finalization. Queue values are never authority.
- `QuarantineObjectPort` alone stages the authorized object into job-scoped
  ephemeral storage.
- `MalwareScannerPort` exposes only an independently verified upstream-signed
  snapshot and clean/infected result.
- `IsolatedDocumentWorkerPort` has no storage, queue, database, or cloud access.
- `NormalizedDocumentPublisherPort` idempotently publishes the validated
  internal artifact and returns a text-free opaque reference for durable state.
- `EphemeralWorkspacePort` must remove input and output before terminal
  finalization. Cleanup failure prevents success.

Concrete trusted-side adapters now include bounded Alibaba OSS quarantine reads,
overwrite-protected internal artifact writes, exclusive private-file staging, a
content-addressed immutable normalized-document publisher, and a ClamAV adapter
implementing ADR 0035's `upstream-clamav-cloud-demo-v1` profile. The connected
maintenance publisher verifies each official CVD/CLD upstream signature with
the pinned ClamAV 1.4.5 `sigtool`, records the exact closed filename set,
database versions, build/publication times, byte lengths, hashes, and toolchain
identity, publishes at an immutable content-addressed OSS prefix, and writes the
readiness marker last. Runtime admission independently repeats the upstream
signature, hash, length, filename-set, toolchain, content-address, and 24-hour
freshness checks before mounting the databases read-only into the networkless
scanner. This bounded demo profile has no Reflo signing key, KMS adapter, or
detached Reflo signature. The scanner treats only ClamAV's documented
clean/infected exit statuses as results.
`@reflo/db` provides the production RDS operation store: it claims only a
pre-existing `ingestion_operation` binding, rechecks active scope ownership and
source retention under a least-privilege RLS role, bounds leases to five
deliveries, and atomically updates the operation attempt and source parse status
on compare-and-set finalization.

The worker `Containerfile` implements D-GH-95 with architecture-specific,
digest-pinned Temurin 25 Jammy builder and runtime images, Java 17 bytecode,
ClamAV 1.4.5, Tesseract 5.5.2, and checksum-pinned English
`tessdata_fast`. The runtime omits compilers, downloaders, package caches, and
ClamAV's network updater. Non-development configuration rejects mutable image
references. A deployment digest is not eligible until the image's package list,
licenses, SBOM, vulnerability report, tessdata checksum, and frozen-fixture
report are recorded together; contract tests and deterministic fakes do not
satisfy that gate.

EPUB and DOCX never receive invented page numbers. Their dormant groundwork
continues to enforce byte, archive, content, and resource ceilings, and EPUB
blocks carry the normalized OPF resource path and actual zero-based spine item.
Future product exposure requires approved deterministic format-native limits,
representative rights-cleared security and latency evidence, and an updated
product support contract.
