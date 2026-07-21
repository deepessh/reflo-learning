import { describe, expect, it } from "vitest";

import type { InternalArtifactObjectPort } from "../ports.js";
import { normalizedDocument } from "../testing-fixtures.js";
import { ObjectArtifactPublisher } from "./object-artifact-publisher.js";

describe("ObjectArtifactPublisher", () => {
  it("publishes a deterministic immutable artifact without returning its key", async () => {
    const stored = new Map<string, { bytes: Uint8Array; sha256: string }>();
    const objects: InternalArtifactObjectPort = {
      async putIfAbsent(input) {
        const existing = stored.get(input.objectKey);
        if (existing === undefined) {
          stored.set(input.objectKey, {
            bytes: input.bytes,
            sha256: input.sha256,
          });
        }
        return {
          byteLength: input.bytes.byteLength,
          objectKey: input.objectKey,
          sha256: input.sha256,
        };
      },
    };
    const publisher = new ObjectArtifactPublisher(objects);
    const document = normalizedDocument("pdf", "a".repeat(64));
    const first = await publisher.publish({
      command: command(document.inputSha256),
      document,
    });
    const second = await publisher.publish({
      command: command(document.inputSha256),
      document,
    });

    expect(first).toEqual(second);
    expect(first.artifactId).toMatch(/^artifact-[a-f0-9]{32}$/);
    expect(stored.size).toBe(1);
    expect([...stored.keys()][0]).toBe(
      `owners/scope-test-0001/ingestion-artifacts/v1/${first.artifactId}.json`,
    );
    expect(JSON.stringify(first)).not.toContain("ingestion-artifacts/");
  });

  it("never deduplicates an internal artifact across owner scopes", async () => {
    const keys: string[] = [];
    const objects: InternalArtifactObjectPort = {
      async putIfAbsent(input) {
        keys.push(input.objectKey);
        return {
          byteLength: input.bytes.byteLength,
          objectKey: input.objectKey,
          sha256: input.sha256,
        };
      },
    };
    const publisher = new ObjectArtifactPublisher(objects);
    const document = normalizedDocument("pdf", "a".repeat(64));
    const first = await publisher.publish({
      command: command(document.inputSha256),
      document,
    });
    const second = await publisher.publish({
      command: {
        ...command(document.inputSha256),
        ownerScopeId: "scope-test-0002",
      },
      document,
    });

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("fails closed when immutable storage reports different content", async () => {
    const objects: InternalArtifactObjectPort = {
      async putIfAbsent(input) {
        return { ...input, sha256: "0".repeat(64) };
      },
    };
    const document = normalizedDocument("pdf", "a".repeat(64));
    await expect(
      new ObjectArtifactPublisher(objects).publish({
        command: command(document.inputSha256),
        document,
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
  });
});

function command(expectedInputSha256: string) {
  return {
    expectedInputSha256,
    operationId: "operation-test-0001",
    ownerScopeId: "scope-test-0001",
    sourceDocumentId: "source-test-0001",
  };
}
