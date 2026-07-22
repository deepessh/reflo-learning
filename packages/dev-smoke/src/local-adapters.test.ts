import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DevelopmentVideoArtifactError,
  LOCAL_SMOKE_PODMAN_VERSIONS,
  LocalSmokeObjectStore,
  copyDevelopmentVideoArtifact,
  isSupportedLocalSmokePodmanVersion,
  readLocalSmokeConfiguration,
} from "./index.js";
import type { SmokePreflightError } from "./index.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local smoke boundaries", () => {
  it("accepts only the explicit development Podman compatibility set", () => {
    expect(LOCAL_SMOKE_PODMAN_VERSIONS).toEqual(["5.8.3", "6.0.1"]);
    expect(isSupportedLocalSmokePodmanVersion("podman version 5.8.3")).toBe(
      true,
    );
    expect(isSupportedLocalSmokePodmanVersion("podman version 6.0.1")).toBe(
      true,
    );
    for (const output of [
      "podman version 5.8.0",
      "podman version 5.8.1",
      "podman version 5.8.2",
      "podman version 6.0.0",
      "podman version 6.0.2",
      "docker version 5.8.3",
    ]) {
      expect(isSupportedLocalSmokePodmanVersion(output)).toBe(false);
    }
  });

  it("rejects activation outside development with an actionable component", () => {
    expect(() =>
      readLocalSmokeConfiguration({ REFLO_ENV: "pilot" }, process.cwd()),
    ).toThrowError(
      expect.objectContaining<Partial<SmokePreflightError>>({
        component: "environment",
      }),
    );
  });

  it("keeps optional fal video default-off and validates enabled configuration", () => {
    const disabled = readLocalSmokeConfiguration(
      localConfigurationEnvironment(),
      process.cwd(),
    );
    expect(disabled.videoEnabled).toBe(false);
    expect(disabled.fal).toBeUndefined();

    expect(() =>
      readLocalSmokeConfiguration(
        { ...localConfigurationEnvironment(), REFLO_LOCAL_SMOKE_VIDEO: "true" },
        process.cwd(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SmokePreflightError>>({
        component: "video",
      }),
    );

    const enabled = readLocalSmokeConfiguration(
      {
        ...localConfigurationEnvironment(),
        REFLO_FAL_KEY: "dev-only-placeholder",
        REFLO_FAL_MEDIA_LIFETIME_SECONDS: "3600",
        REFLO_FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
        REFLO_LOCAL_SMOKE_VIDEO: "true",
      },
      process.cwd(),
    );
    expect(enabled.videoEnabled).toBe(true);
    expect(enabled.fal).toEqual({
      apiKey: "dev-only-placeholder",
      mediaLifetimeSeconds: "3600",
      videoModel: "fal-ai/wan/v2.7/text-to-video",
    });

    expect(() =>
      readLocalSmokeConfiguration(
        {
          ...localConfigurationEnvironment(),
          REFLO_LOCAL_SMOKE_VIDEO: "yes",
        },
        process.cwd(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SmokePreflightError>>({
        component: "video",
      }),
    );
  });

  it("writes immutable text and audio artifacts without overwriting", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reflo-smoke-test-"));
    scratch.push(directory);
    const store = new LocalSmokeObjectStore(directory);
    const text = "grounded fixture lesson";
    const textHash = digest(Buffer.from(text));
    const textResult = await store.putImmutable({
      content: text,
      contentHash: textHash,
      idempotencyKey: "dev/test/text",
      objectKey: "owners/test/assets/text.md",
    });
    await store.putImmutable({
      content: text,
      contentHash: textHash,
      idempotencyKey: "dev/test/text",
      objectKey: "owners/test/assets/text.md",
    });

    expect(textResult.contentType).toBe("text/markdown; charset=utf-8");
    expect(
      await readFile(
        path.join(directory, "owners/test/assets/text.md"),
        "utf8",
      ),
    ).toBe(text);
    await expect(
      store.putImmutable({
        content: "different",
        contentHash: digest(Buffer.from("different")),
        idempotencyKey: "dev/test/text",
        objectKey: "owners/test/assets/text.md",
      }),
    ).rejects.toBeDefined();
  });

  it("rejects object keys that escape the ignored smoke root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reflo-smoke-test-"));
    scratch.push(directory);
    const store = new LocalSmokeObjectStore(directory);

    await expect(
      store.putIfAbsent({
        bytes: Buffer.from("fixture"),
        objectKey: "../outside",
        sha256: digest(Buffer.from("fixture")),
      }),
    ).rejects.toThrowError(/unsafe local smoke object key/);
  });

  it("copies validated fal output into a private deterministic local path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reflo-smoke-test-"));
    scratch.push(directory);
    const store = new LocalSmokeObjectStore(directory);
    const bytes = Buffer.from("synthetic-mp4-fixture");

    const copied = await copyDevelopmentVideoArtifact({
      courseId: "11200000-0000-4000-8000-000000000004",
      fetch: async () =>
        new Response(bytes, {
          headers: {
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "video/mp4",
          },
        }),
      mimeType: "video/mp4",
      ownerScopeId: "11200000-0000-4000-8000-000000000002",
      store,
      uri: "https://v3b.fal.media/files/synthetic/provider-name.mp4",
    });

    expect(copied).toMatchObject({
      byteSize: bytes.byteLength,
      contentSha256: digest(bytes),
    });
    expect(copied.objectKey).toContain(
      `/generations/${digest(bytes)}/payload.mp4`,
    );
    expect(copied.objectKey).not.toContain("provider-name");
    expect(await store.read(copied.objectKey)).toEqual(bytes);
  });

  it("rejects unsafe or mislabeled development video output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reflo-smoke-test-"));
    scratch.push(directory);
    const store = new LocalSmokeObjectStore(directory);

    await expect(
      copyDevelopmentVideoArtifact({
        courseId: "11200000-0000-4000-8000-000000000004",
        fetch: async () =>
          new Response("not-video", {
            headers: { "Content-Type": "text/plain" },
          }),
        mimeType: "video/mp4",
        ownerScopeId: "11200000-0000-4000-8000-000000000002",
        store,
        uri: "https://v3b.fal.media/files/synthetic/output.mp4",
      }),
    ).rejects.toBeInstanceOf(DevelopmentVideoArtifactError);

    await expect(
      copyDevelopmentVideoArtifact({
        courseId: "11200000-0000-4000-8000-000000000004",
        mimeType: "video/mp4",
        ownerScopeId: "11200000-0000-4000-8000-000000000002",
        store,
        uri: "https://127.0.0.1/private",
      }),
    ).rejects.toBeInstanceOf(DevelopmentVideoArtifactError);
  });
});

function localConfigurationEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost/reflo",
    REFLO_ENV: "dev",
    REFLO_LITELLM_API_KEY: "dev-only-placeholder",
    REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4000",
    REFLO_LITELLM_EMBEDDING_MODEL: "local-embedding",
    REFLO_LITELLM_TEXT_MODEL: "local-text",
    REFLO_LOCAL_CLAMAV_DATABASE_DIR: "/tmp/clamav",
    REFLO_LOCAL_INGESTION_IMAGE: "reflo-ingestion:test",
    REFLO_LOCAL_INGESTION_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    REFLO_LOCAL_PIPER_ARTIFACT_REVISION: "b".repeat(40),
    REFLO_LOCAL_PIPER_CONFIG_PATH: "/tmp/voice.json",
    REFLO_LOCAL_PIPER_CONFIG_SHA256: "c".repeat(64),
    REFLO_LOCAL_PIPER_MODEL_PATH: "/tmp/voice.onnx",
    REFLO_LOCAL_PIPER_MODEL_SHA256: "d".repeat(64),
    REFLO_LOCAL_PIPER_PYTHON: "/tmp/python",
    REFLO_LOCAL_PIPER_VOICE_ARTIFACT_VERSION:
      "piper-voice-en-us-ljspeech-high-v1",
    REFLO_LOCAL_SMOKE_VIDEO: "false",
    REFLO_LOCAL_TESSDATA_DIR: "/tmp/tessdata",
    REFLO_VECTOR_DATABASE_URL: "postgresql://localhost/reflo_vector",
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
