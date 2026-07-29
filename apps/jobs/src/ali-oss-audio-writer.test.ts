import { createHash } from "node:crypto";

import type { RefloOssClient } from "@reflo/asset-delivery";
import { describe, expect, it, vi } from "vitest";

import { AliOssAudioArtifactWriter } from "./ali-oss-audio-writer.js";

const objectKey =
  "owners/30000000-0000-4000-8000-000000000001/courses/30000000-0000-4000-8000-000000000002/assets/30000000-0000-4000-8000-000000000003/generations/30000000-0000-4000-8000-000000000004/audio.wav";
const idempotencyKey =
  "dev/media.audio.generate/v1/30000000-0000-4000-8000-000000000005";
const bytes = new Uint8Array(48).fill(7);
const contentSha256 = createHash("sha256").update(bytes).digest("hex");

describe("Ali OSS audio writer", () => {
  it("creates a private immutable WAV object", async () => {
    const client = fakeClient();
    const writer = new AliOssAudioArtifactWriter(client);

    await expect(
      writer.putImmutable({
        bytes,
        contentSha256,
        idempotencyKey,
        objectKey,
      }),
    ).resolves.toEqual({
      byteSize: 48,
      contentType: "audio/wav",
      etag: contentSha256,
      objectKey,
    });
    expect(client.put).toHaveBeenCalledWith(objectKey, bytes, {
      headers: {
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-reflo-idempotency": idempotencyKey,
        "x-oss-meta-reflo-sha256": contentSha256,
      },
      mime: "audio/wav",
    });
  });

  it("accepts only a byte-for-byte matching replay", async () => {
    const client = fakeClient();
    vi.mocked(client.put).mockRejectedValue({ code: "FileAlreadyExists" });
    vi.mocked(client.head).mockResolvedValue({
      meta: {
        "reflo-idempotency": idempotencyKey,
        "reflo-sha256": contentSha256,
      },
      res: { size: bytes.byteLength, status: 200 },
    });
    const writer = new AliOssAudioArtifactWriter(client);

    await expect(
      writer.putImmutable({
        bytes,
        contentSha256,
        idempotencyKey,
        objectKey,
      }),
    ).resolves.toMatchObject({ objectKey });
  });

  it("rejects a mismatched replay", async () => {
    const client = fakeClient();
    vi.mocked(client.put).mockRejectedValue({ code: "FileAlreadyExists" });
    vi.mocked(client.head).mockResolvedValue({
      meta: {
        "reflo-idempotency": idempotencyKey,
        "reflo-sha256": "f".repeat(64),
      },
      res: { size: bytes.byteLength, status: 200 },
    });
    const writer = new AliOssAudioArtifactWriter(client);

    await expect(
      writer.putImmutable({
        bytes,
        contentSha256,
        idempotencyKey,
        objectKey,
      }),
    ).rejects.toThrow("immutable OSS audio identity mismatch");
  });
});

function fakeClient(): RefloOssClient {
  return {
    get: vi.fn(),
    head: vi.fn(),
    put: vi.fn().mockResolvedValue({ res: { status: 200 } }),
  };
}
