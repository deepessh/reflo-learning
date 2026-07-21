import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IngestionError } from "../errors.js";
import { NodeEphemeralWorkspace } from "./ephemeral-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("NodeEphemeralWorkspace", () => {
  it("creates a unique job directory and removes every artifact", async () => {
    const base = await temporaryBase();
    const workspaces = new NodeEphemeralWorkspace(base);
    const first = await workspaces.create("operation-0001");
    const second = await workspaces.create("operation-0001");
    expect(first.directory).not.toBe(second.directory);
    expect(path.dirname(first.directory)).toBe(base);
    await writeFile(
      path.join(first.outputDirectory, "untrusted.tmp"),
      "payload",
    );
    await workspaces.cleanup(first);
    await expect(lstat(first.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await workspaces.cleanup(second);
  });

  it("refuses a symlink base and cleanup outside the configured root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reflo-workspace-root-"));
    roots.push(root);
    const real = path.join(root, "real-workspaces");
    const linked = path.join(root, "linked-workspaces");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    await expectFailure(
      new NodeEphemeralWorkspace(linked).create("operation-0001"),
    );

    const workspaces = new NodeEphemeralWorkspace(real);
    await expectFailure(
      workspaces.cleanup({
        directory: root,
        outputDirectory: path.join(root, "output"),
      }),
    );
  });
});

async function temporaryBase(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reflo-workspace-root-"));
  roots.push(root);
  const base = path.join(root, "job-workspaces");
  await mkdir(base, { mode: 0o700 });
  return base;
}

async function expectFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("expected workspace operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).code).toBe("infrastructure_unavailable");
  }
}
