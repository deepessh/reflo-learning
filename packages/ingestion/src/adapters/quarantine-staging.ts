import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  INGESTION_LIMITS,
  type AuthorizedQuarantinedSource,
  type StagedUpload,
} from "../contracts.js";
import { IngestionError } from "../errors.js";
import type {
  IngestionWorkspace,
  QuarantineDownloadPort,
  QuarantineObjectPort,
} from "../ports.js";

export class QuarantineStagingAdapter implements QuarantineObjectPort {
  constructor(private readonly download: QuarantineDownloadPort) {}

  async stage(
    source: AuthorizedQuarantinedSource,
    workspace: IngestionWorkspace,
  ): Promise<StagedUpload> {
    const inputPath = path.join(workspace.directory, "source");
    if (
      !path.isAbsolute(workspace.directory) ||
      workspace.outputDirectory !== path.join(workspace.directory, "output")
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    const downloaded = await this.download.getObject({
      maximumBytes: INGESTION_LIMITS.largeDocument.maxBytes,
      objectKey: source.objectKey,
    });
    if (
      downloaded.objectKey !== source.objectKey ||
      downloaded.bytes.byteLength < 1 ||
      downloaded.bytes.byteLength > INGESTION_LIMITS.largeDocument.maxBytes
    ) {
      throw new IngestionError("hash_mismatch");
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(inputPath, "wx", 0o600);
      await handle.writeFile(downloaded.bytes);
      await handle.sync();
    } catch {
      throw new IngestionError("infrastructure_unavailable");
    } finally {
      await handle?.close().catch(() => undefined);
    }

    return {
      byteLength: downloaded.bytes.byteLength,
      bytes: downloaded.bytes,
      inputPath,
      sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
    };
  }
}
