---
id: "0020"
title: "Java 25 base family for the isolated-ingestion worker"
status: Accepted
date: "2026-07-21"
aliases: [D-GH-95]
prd_references: "`prds/reflo-prd.md` §6 F1, §9, §11, and §13; D-GH-5 and D-GH-8"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #29"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/95
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/95#issuecomment-5037154238
  record_pr: https://github.com/deepessh/reflo-learning/pull/97
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0020: Java 25 base family for the isolated-ingestion worker

## Context

D-GH-8 requires one reproducible isolated-ingestion image with exact component, base-image, platform, and final-image pins, but it intentionally selects no Java distribution or operating-system base and authorizes no deployment digest before the image passes its gates. The worker uses Tika 3.3.1 and PDFBox AWT rendering in headless mode, compiles for Java 17, and must package exact ClamAV and Tesseract runtimes without adding network or credential authority. This verdict controls only the Java runtime distribution, major version, Ubuntu base family, bytecode compatibility target, immutable-reference requirement, and Java-major rollback boundary for that image. It does not select an exact update or digest before build evidence exists; change any D-GH-8 component, limit, isolation control, fixture, or release gate; authorize a production signing profile governed by issue #96; or authorize deployment, ECS capacity, spending, or pilot activation.

## Options

Eclipse Temurin 17, 21, or 25 JRE on Ubuntu Jammy; Debian 13 plus a separately verified Temurin runtime; UBI 9 plus Temurin; and Alpine/musl. Ubuntu Noble was reviewed as a future OS-base upgrade but not selected because changing both the Java and operating-system families adds unrelated qualification work to the sprint.

## Decision

### Authorized verdict

Use an architecture-specific Eclipse Temurin 25 JRE Ubuntu Jammy base family for `isolated-ingestion-v1`. The implementation selects a full Java update tag and pins the `linux/amd64` platform image by SHA-256 digest; a rolling `25-jre-jammy` tag is discovery input only and never deployment authority. Record the source repository, full tag, platform, base-image digest, reported Java runtime version, installed operating-system and native-package identities, source commit, final image digest, SBOM, licenses, vulnerability report, tessdata digest, and frozen-fixture report in the D-GH-8 provenance evidence. Use a separate exact build stage and leave no compiler, package manager cache, downloader, build credential, or mutable dependency reference in the runtime image. Continue compiling worker bytecode with `maven.compiler.release=17`; adopting Java-25-only language features or APIs requires a separately authorized semantic change. Java 21 or 17 is a rollback candidate only when Java 25 fails a D-GH-8 native dependency, PDFBox/AWT, license, vulnerability, support, provenance, or frozen real-container fixture gate, and rollback requires a newly built, fully requalified, digest-pinned image rather than an unreviewed tag substitution.

### Rationale

Apache Tika 3.x requires Java 11 or newer rather than Java 17 specifically, and the current PDF, DOCX, and EPUB worker fixtures pass in a clean OpenJDK 25.0.2 build with explicit headless rendering. Java 25 is the current LTS line and provides a longer support runway than 17 or 21, while Eclipse Temurin provides an official JRE image family without hand-assembling a Java runtime. Retaining Java 17 bytecode compatibility separates the runtime-support upgrade from application-language adoption and preserves a lower-cost rollback path. Jammy keeps the already-reviewed glibc and native-library base constant; Debian, UBI, Noble, and Alpine would expand package, libc, or OS qualification without evidence that the added work improves the sprint outcome.

## Verification

Repository policy rejects worker deployment references that lack the selected full Temurin 25 update identity, `linux/amd64` platform, and immutable base and final SHA-256 digests; mutable-only image references; a runtime outside the Jammy Temurin JRE family; bytecode compiled above release 17; and provenance missing any required identity or evidence digest. The real image asserts the exact `java -version`, runs headless, contains no JDK/compiler or build tooling, and passes the full D-GH-8 PDF, EPUB, DOCX, malware, OCR, archive, timeout, OOM, parser-crash, isolation, cleanup, license, SBOM, and vulnerability gates with the exact native artifacts. Cross-checks prove the admitted platform digest resolves to the recorded manifest and the deployed digest resolves to the tested bytes. A Java 21 or 17 rollback cannot reuse Java 25 evidence and must repeat every affected gate.

## Reversal criteria

Supersede if Temurin 25 Jammy lacks a supportable exact JRE image, cannot package or run the pinned native toolchain, fails PDFBox/AWT or frozen fixtures, introduces an unacceptable vulnerability or license result, cannot meet the PRD latency and resource gates, or creates materially higher operational risk than a requalified Java 21, Java 17, Noble, Debian, or UBI image. Any successor must preserve exact platform and digest identity, networkless credential-free execution, reproducible provenance, full requalification, and every D-GH-8 gate.
