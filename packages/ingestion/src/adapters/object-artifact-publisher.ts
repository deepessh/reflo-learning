import { createHash } from "node:crypto";

import type {
  IngestionCommand,
  NormalizedDocument,
  NormalizedDocumentArtifact,
} from "../contracts.js";
import { IngestionError } from "../errors.js";
import type {
  InternalArtifactObjectPort,
  NormalizedDocumentPublisherPort,
} from "../ports.js";

export class ObjectArtifactPublisher implements NormalizedDocumentPublisherPort {
  constructor(private readonly objects: InternalArtifactObjectPort) {}

  async publish(input: {
    readonly command: IngestionCommand;
    readonly document: NormalizedDocument;
  }): Promise<NormalizedDocumentArtifact> {
    const bytes = Buffer.from(JSON.stringify(input.document), "utf8");
    const documentSha256 = sha256(bytes);
    const artifactId = `artifact-${sha256(
      Buffer.from(
        `${input.command.ownerScopeId}:${input.command.operationId}:${documentSha256}`,
        "utf8",
      ),
    ).slice(0, 32)}`;
    const objectKey =
      `owners/${input.command.ownerScopeId}/` +
      `ingestion-artifacts/v1/${artifactId}.json`;
    const stored = await this.objects.putIfAbsent({
      bytes,
      objectKey,
      sha256: documentSha256,
    });
    if (
      stored.objectKey !== objectKey ||
      stored.byteLength !== bytes.byteLength ||
      stored.sha256 !== documentSha256
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    return {
      artifactId,
      blockCount: input.document.blocks.length,
      byteLength: bytes.byteLength,
      documentKind: input.document.documentKind,
      documentSha256,
      inputSha256: input.document.inputSha256,
      pageCount: input.document.pageCount,
      parserVersion: input.document.parserVersion,
      workerImageDigest: input.document.workerImageDigest,
    };
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
