import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_SMOKE_PODMAN_VERSIONS,
  LocalSmokeObjectStore,
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
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
