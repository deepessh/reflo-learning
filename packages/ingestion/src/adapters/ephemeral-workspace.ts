import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { IngestionError } from "../errors.js";
import type { EphemeralWorkspacePort, IngestionWorkspace } from "../ports.js";

export class NodeEphemeralWorkspace implements EphemeralWorkspacePort {
  readonly #baseDirectory: string;

  constructor(baseDirectory: string) {
    const resolved = path.resolve(baseDirectory);
    if (
      !path.isAbsolute(baseDirectory) ||
      resolved === path.parse(resolved).root ||
      path.basename(resolved).length < 8
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    this.#baseDirectory = resolved;
  }

  async create(operationId: string): Promise<IngestionWorkspace> {
    validateOperationId(operationId);
    await this.#assertSafeBase();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(
        path.join(this.#baseDirectory, `${operationId}-`),
      );
      await mkdir(path.join(directory, "output"), { mode: 0o700 });
      return { directory, outputDirectory: path.join(directory, "output") };
    } catch {
      if (directory !== undefined) {
        await rm(directory, { force: true, recursive: true }).catch(
          () => undefined,
        );
      }
      throw new IngestionError("infrastructure_unavailable");
    }
  }

  async cleanup(workspace: IngestionWorkspace): Promise<void> {
    await this.#assertSafeBase();
    const directory = path.resolve(workspace.directory);
    const relative = path.relative(this.#baseDirectory, directory);
    const metadata = await lstat(directory).catch(() => null);
    if (
      relative.length === 0 ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep) ||
      workspace.outputDirectory !== path.join(directory, "output") ||
      metadata === null ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    await rm(directory, { force: false, recursive: true });
  }

  async #assertSafeBase(): Promise<void> {
    const metadata = await lstat(this.#baseDirectory).catch(() => null);
    if (
      metadata === null ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
  }
}

function validateOperationId(operationId: string): void {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(operationId)) {
    throw new IngestionError("infrastructure_unavailable");
  }
}
