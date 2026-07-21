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

`IngestionSupervisor` is intentionally composed from narrow ports:

- `IngestionOperationStore` owns authorization rechecks and D-GH-12 claim/CAS
  finalization. Queue values are never authority.
- `QuarantineObjectPort` alone stages the authorized object into job-scoped
  ephemeral storage.
- `MalwareScannerPort` exposes only a signed snapshot and clean/infected result.
- `IsolatedDocumentWorkerPort` has no storage, queue, database, or cloud access.
- `NormalizedDocumentPublisherPort` idempotently publishes the validated
  internal artifact and returns a text-free opaque reference for durable state.
- `EphemeralWorkspacePort` must remove input and output before terminal
  finalization. Cleanup failure prevents success.

Concrete trusted-side adapters now include bounded Alibaba OSS quarantine reads,
overwrite-protected internal artifact writes, exclusive private-file staging, a
content-addressed immutable normalized-document publisher, and a ClamAV adapter
that verifies the exact D-GH-96 P-256 detached-signature profile and every
database file before accepting a snapshot. The maintenance publisher validates
each CVD/CLD with ClamAV 1.4.5, signs the exact immutable manifest through the
Alibaba KMS `AsymmetricSign` digest adapter, and writes the readiness marker
last. Activation still requires the D-GH-96 real-KMS golden vector for the
provisioned key. The scanner checks the runtime is exactly ClamAV 1.4.5 and
treats only its documented clean/infected exit statuses as results.
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

EPUB and DOCX never receive invented page numbers. Their byte, archive,
content, and resource ceilings are enforced, but their PRD 200/800-page
requirement remains unresolved as recorded in D-GH-8 and must not be reported
as passing. EPUB blocks do carry the normalized OPF resource path and actual
zero-based spine item.
