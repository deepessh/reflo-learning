import { describe, expect, it } from "vitest";

import { IngestionError } from "./errors.js";
import { IngestionSupervisor } from "./service.js";
import {
  DeterministicDocumentWorker,
  DeterministicMalwareScanner,
  DeterministicNormalizedDocumentPublisher,
  DeterministicWorkspacePort,
  FixedIngestionClock,
  InMemoryIngestionOperationStore,
  InMemoryQuarantineObjectPort,
} from "./testing.js";
import {
  normalizedDocument,
  sha256,
  sourceFor,
  validPdf,
} from "./testing-fixtures.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

describe("IngestionSupervisor", () => {
  it("parses a valid source, cleans ephemeral data, and replays the stored outcome", async () => {
    const harness = createHarness();
    const first = await harness.supervisor.execute(harness.command);
    expect(first).toMatchObject({
      kind: "completed",
      outcome: { kind: "parsed", processingLane: "standard" },
    });
    expect(harness.worker.requests).toHaveLength(1);
    expect(harness.workspaces.cleaned).toEqual([
      "/tmp/reflo-ingestion-tests/operation-0001-attempt-0001",
    ]);

    const replay = await harness.supervisor.execute(harness.command);
    expect(replay).toEqual(first);
    expect(harness.worker.requests).toHaveLength(1);
    expect(harness.quarantine.stageCalls).toBe(1);
    expect(harness.operations.finalizeCalls).toBe(1);
  });

  it("routes mixed and scanned PDFs to visible asynchronous OCR", async () => {
    const harness = createHarness({
      workerOutput: normalizedDocument("pdf", sha256(validPdf()), {
        candidatePages: [1],
        pageCount: 1,
      }),
    });
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      kind: "completed",
      outcome: {
        candidatePages: [1],
        classification: "scanned",
        kind: "ocr_required",
        processingLane: "large",
      },
    });
  });

  it("marks stable-page documents over 200 pages as asynchronous large work", async () => {
    const harness = createHarness({
      workerOutput: normalizedDocument("pdf", sha256(validPdf()), {
        pageCount: 201,
      }),
    });
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: { kind: "parsed", processingLane: "large" },
    });
  });

  it("fails closed over the 800 stable-page product maximum", async () => {
    const harness = createHarness({
      workerOutput: normalizedDocument("pdf", sha256(validPdf()), {
        pageCount: 801,
      }),
    });
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: { code: "page_limit", retryable: false },
        kind: "failed",
      },
    });
  });

  it("fails closed when authorization is absent before staging", async () => {
    const harness = createHarness({ authorized: false });
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: { code: "authorization_denied", retryable: false },
        kind: "failed",
      },
    });
    expect(harness.quarantine.stageCalls).toBe(0);
    expect(harness.worker.requests).toHaveLength(0);
  });

  it("reauthorizes after parsing and before publishing", async () => {
    const harness = createHarness();
    const resolve = harness.operations.resolveAuthorizedSource.bind(
      harness.operations,
    );
    let resolveCalls = 0;
    harness.operations.resolveAuthorizedSource = async (command) => {
      resolveCalls += 1;
      return resolveCalls === 1 ? resolve(command) : null;
    };

    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: { code: "authorization_denied", retryable: false },
        kind: "failed",
      },
    });
    expect(harness.worker.requests).toHaveLength(1);
    expect(harness.publisher.published).toHaveLength(0);
  });

  it("fails closed for missing, invalid, future, or older-than-24h scan databases", async () => {
    for (const snapshot of [
      null,
      { publishedAt: NOW, signatureVersion: "daily-1", verified: false },
      {
        publishedAt: new Date(NOW.getTime() + 1),
        signatureVersion: "daily-1",
        verified: true,
      },
      {
        publishedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000 - 1),
        signatureVersion: "daily-1",
        verified: true,
      },
    ]) {
      const harness = createHarness({ snapshot });
      await expect(
        harness.supervisor.execute(harness.command),
      ).resolves.toMatchObject({
        outcome: {
          failure: { code: "scan_db_stale", retryable: false },
          kind: "failed",
        },
      });
      expect(harness.worker.requests).toHaveLength(0);
      expect(harness.workspaces.cleaned).toHaveLength(1);
    }
  });

  it("does not parse malware and records a sanitized deterministic failure", async () => {
    const harness = createHarness();
    harness.scanner.clean = false;
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: { code: "malware_detected", retryable: false },
        kind: "failed",
      },
    });
    expect(harness.worker.requests).toHaveLength(0);
  });

  it("does not finalize success when ephemeral cleanup is incomplete", async () => {
    const harness = createHarness();
    harness.workspaces.failCleanup = true;
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: {
          code: "infrastructure_unavailable",
          retryable: true,
          sanitizedDetail: "ephemeral_cleanup_incomplete",
        },
        kind: "failed",
      },
    });
  });

  it("normalizes parser crashes and never exposes raw diagnostics", async () => {
    const harness = createHarness({
      workerOutput: new Error("secret provider payload"),
    });
    const result = await harness.supervisor.execute(harness.command);
    expect(result).toMatchObject({
      outcome: {
        failure: { code: "infrastructure_unavailable", retryable: true },
        kind: "failed",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret provider payload");
  });

  it("returns in-progress for a concurrent duplicate without running work", async () => {
    const harness = createHarness();
    harness.operations.setActive(harness.command.operationId);
    await expect(harness.supervisor.execute(harness.command)).resolves.toEqual({
      kind: "in_progress",
    });
    expect(harness.quarantine.stageCalls).toBe(0);
  });

  it("preserves normalized deterministic worker failure codes", async () => {
    const harness = createHarness({
      workerOutput: new IngestionError("parse_oom"),
    });
    await expect(
      harness.supervisor.execute(harness.command),
    ).resolves.toMatchObject({
      outcome: {
        failure: { code: "parse_oom", retryable: false },
        kind: "failed",
      },
    });
  });
});

function createHarness(
  options: {
    readonly authorized?: boolean;
    readonly snapshot?: null | {
      readonly publishedAt: Date;
      readonly signatureVersion: string;
      readonly verified: boolean;
    };
    readonly workerOutput?: unknown;
  } = {},
) {
  const bytes = validPdf();
  const source = sourceFor("pdf", bytes);
  const operations = new InMemoryIngestionOperationStore();
  if (options.authorized !== false) {
    operations.addSource(source);
  }
  const quarantine = new InMemoryQuarantineObjectPort();
  quarantine.add(source.objectKey, bytes);
  const scanner = new DeterministicMalwareScanner(
    options.snapshot === undefined
      ? {
          publishedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
          signatureVersion: "daily-1",
          verified: true,
        }
      : options.snapshot,
  );
  const worker = new DeterministicDocumentWorker(
    options.workerOutput ??
      normalizedDocument("pdf", source.expectedInputSha256),
  );
  const workspaces = new DeterministicWorkspacePort();
  const publisher = new DeterministicNormalizedDocumentPublisher();
  const supervisor = new IngestionSupervisor({
    clock: new FixedIngestionClock(NOW),
    malwareScanner: scanner,
    operations,
    publisher,
    quarantine,
    worker,
    workspaces,
  });
  return {
    command: {
      expectedInputSha256: source.expectedInputSha256,
      operationId: "operation-0001",
      ownerScopeId: source.ownerScopeId,
      sourceDocumentId: source.sourceDocumentId,
    },
    operations,
    publisher,
    quarantine,
    scanner,
    supervisor,
    worker,
    workspaces,
  };
}
