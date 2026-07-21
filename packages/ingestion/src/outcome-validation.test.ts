import { describe, expect, it } from "vitest";

import { normalizedDocument } from "./testing-fixtures.js";
import { DeterministicNormalizedDocumentPublisher } from "./testing.js";
import { validateIngestionOutcome } from "./outcome-validation.js";

describe("validateIngestionOutcome", () => {
  it("accepts replay-safe parsed and retry outcomes", async () => {
    const document = normalizedDocument("pdf", "a".repeat(64));
    const artifact =
      await new DeterministicNormalizedDocumentPublisher().publish({
        command: {
          expectedInputSha256: document.inputSha256,
          operationId: "operation-test-0001",
          ownerScopeId: "scope-test-0001",
          sourceDocumentId: "source-test-0001",
        },
        document,
      });
    expect(
      validateIngestionOutcome({
        artifact,
        kind: "parsed",
        processingLane: "standard",
      }),
    ).toMatchObject({ kind: "parsed" });
    expect(
      validateIngestionOutcome({
        failure: { code: "infrastructure_unavailable", retryable: true },
        kind: "failed",
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("rejects unknown fields and forged retryability", () => {
    expect(() =>
      validateIngestionOutcome({
        failure: { code: "malware_detected", retryable: true },
        kind: "failed",
      }),
    ).toThrow();
    expect(() =>
      validateIngestionOutcome({
        failure: { code: "malware_detected", raw: "secret", retryable: false },
        kind: "failed",
      }),
    ).toThrow();
  });
});
