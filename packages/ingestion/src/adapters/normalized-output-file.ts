import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { INGESTION_LIMITS } from "../contracts.js";
import { IngestionError } from "../errors.js";
import type { WorkerOutputReaderPort } from "../ports.js";

export class NormalizedOutputFileReader implements WorkerOutputReaderPort {
  async readNormalizedDocument(outputDirectory: string): Promise<unknown> {
    const outputPath = path.join(outputDirectory, "normalized-document.json");
    let handle;
    try {
      handle = await open(
        outputPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size < 2 ||
        metadata.size > INGESTION_LIMITS.normalizedOutputBytes
      ) {
        throw new IngestionError("invalid_output");
      }
      const bytes = await handle.readFile();
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof IngestionError) {
        throw error;
      }
      throw new IngestionError("invalid_output");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
