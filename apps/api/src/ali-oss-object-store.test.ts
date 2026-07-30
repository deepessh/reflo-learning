import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AliOssConnectedObjectStore,
  type RefloOssClient,
} from "./ali-oss-object-store.js";

describe("connected Alibaba OSS object store", () => {
  it("routes source, internal, and delivery keys to separate private clients", async () => {
    const quarantine = client();
    const artifacts = client();
    const delivery = client();
    const store = new AliOssConnectedObjectStore({
      artifacts,
      delivery,
      quarantine,
    });
    const sourceKey =
      "owners/scope-0001/sources/source-0001/versions/v1/original.pdf";
    const artifactKey =
      "owners/scope-0001/ingestion-artifacts/v1/artifact-0001.json";
    const deliveryKey =
      "owners/scope-0001/courses/course-0001/assets/lesson-0001/generations/gen-0001/payload.md";

    await store.putIfAbsent(write(sourceKey, "source"));
    await store.putIfAbsent(write(artifactKey, "artifact"));
    await store.putImmutable({
      content: "lesson",
      contentHash: digest("lesson"),
      idempotencyKey: "lesson-0001",
      objectKey: deliveryKey,
    });

    expect(quarantine.put).toHaveBeenCalledOnce();
    expect(artifacts.put).toHaveBeenCalledOnce();
    expect(delivery.put).toHaveBeenCalledOnce();
    for (const current of [quarantine, artifacts, delivery]) {
      expect(current.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-oss-forbid-overwrite": "true",
          }),
        }),
      );
    }
  });

  it("accepts only an identical immutable collision", async () => {
    const objectKey =
      "owners/scope-0001/ingestion-artifacts/v1/artifact-0001.json";
    const bytes = Buffer.from("artifact");
    const matching = client({
      put: vi.fn(async () => {
        throw { code: "FileAlreadyExists" };
      }),
      head: vi.fn(async () => ({
        meta: { "reflo-sha256": digest(bytes) },
        res: { size: bytes.byteLength, status: 200 },
      })),
    });
    const store = new AliOssConnectedObjectStore({
      artifacts: matching,
      delivery: client(),
      quarantine: client(),
    });
    await expect(
      store.putIfAbsent({
        bytes,
        objectKey,
        sha256: digest(bytes),
      }),
    ).resolves.toMatchObject({ objectKey });

    matching.head = vi.fn(async () => ({
      meta: { "reflo-sha256": "0".repeat(64) },
      res: { size: bytes.byteLength, status: 200 },
    }));
    await expect(
      store.putIfAbsent({
        bytes,
        objectKey,
        sha256: digest(bytes),
      }),
    ).rejects.toThrow("identity mismatch");
  });

  it("rejects keys outside approved storage boundaries", async () => {
    const store = new AliOssConnectedObjectStore({
      artifacts: client(),
      delivery: client(),
      quarantine: client(),
    });
    await expect(store.read("unscoped/private.txt")).rejects.toThrow(
      "approved boundary",
    );
  });
});

function client(overrides: Partial<RefloOssClient> = {}): RefloOssClient & {
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => ({
      content: Buffer.from("object"),
      res: { status: 200 },
    })),
    head: vi.fn(async () => ({
      meta: { "reflo-sha256": digest("object") },
      res: { size: 6, status: 200 },
    })),
    put: vi.fn(async () => ({ res: { status: 200 } })),
    ...overrides,
  } as never;
}

function write(objectKey: string, content: string) {
  return {
    bytes: Buffer.from(content),
    objectKey,
    sha256: digest(content),
  };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
