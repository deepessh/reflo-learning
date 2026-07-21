import { describe, expect, it, vi } from "vitest";

import {
  AliOssInternalArtifactAdapter,
  AliOssQuarantineDownloadAdapter,
  type AliOssObjectClient,
} from "./ali-oss.js";

describe("Alibaba OSS ingestion adapters", () => {
  it("bounds quarantine objects before downloading and verifies the response", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = clientWith({
      get: vi.fn().mockResolvedValue({ content: bytes, res: { status: 200 } }),
      head: vi.fn().mockResolvedValue({
        res: { headers: { "content-length": "3" }, status: 200 },
      }),
    });
    const adapter = new AliOssQuarantineDownloadAdapter(client);

    await expect(
      adapter.getObject({ maximumBytes: 3, objectKey: "quarantine/a.pdf" }),
    ).resolves.toEqual({ bytes, objectKey: "quarantine/a.pdf" });
    expect(client.head).toHaveBeenCalledBefore(client.get as never);
  });

  it("never downloads an over-limit quarantine object", async () => {
    const client = clientWith({
      head: vi.fn().mockResolvedValue({ res: { size: 4, status: 200 } }),
    });
    await expect(
      new AliOssQuarantineDownloadAdapter(client).getObject({
        maximumBytes: 3,
        objectKey: "quarantine/a.pdf",
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
    expect(client.get).not.toHaveBeenCalled();
  });

  it("uses overwrite protection and verifies an idempotent existing artifact", async () => {
    const digest = "a".repeat(64);
    const bytes = new Uint8Array([1, 2, 3]);
    const put = vi.fn().mockRejectedValue({ code: "FileAlreadyExists" });
    const client = clientWith({
      head: vi.fn().mockResolvedValue({
        meta: { "reflo-sha256": digest },
        res: { size: 3, status: 200 },
      }),
      put,
    });
    const result = await new AliOssInternalArtifactAdapter(client).putIfAbsent({
      bytes,
      objectKey: "owners/scope/artifact.json",
      sha256: digest,
    });

    expect(result).toEqual({
      byteLength: 3,
      objectKey: "owners/scope/artifact.json",
      sha256: digest,
    });
    expect(put.mock.calls[0]?.[2]).toEqual({
      headers: {
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-reflo-sha256": digest,
      },
      mime: "application/json",
    });
  });

  it("rejects conflicting existing content and unsafe keys", async () => {
    const client = clientWith({
      head: vi.fn().mockResolvedValue({
        meta: { "reflo-sha256": "b".repeat(64) },
        res: { size: 3, status: 200 },
      }),
      put: vi.fn().mockRejectedValue({ code: "FileAlreadyExists" }),
    });
    const adapter = new AliOssInternalArtifactAdapter(client);
    await expect(
      adapter.putIfAbsent({
        bytes: new Uint8Array([1, 2, 3]),
        objectKey: "owners/scope/artifact.json",
        sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
    await expect(
      adapter.putIfAbsent({
        bytes: new Uint8Array([1]),
        objectKey: "../artifact.json",
        sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
  });
});

function clientWith(
  overrides: Partial<AliOssObjectClient>,
): AliOssObjectClient {
  return {
    get: vi.fn().mockRejectedValue(new Error("unexpected get")),
    head: vi.fn().mockRejectedValue(new Error("unexpected head")),
    put: vi.fn().mockRejectedValue(new Error("unexpected put")),
    ...overrides,
  };
}
