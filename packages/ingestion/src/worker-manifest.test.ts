import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  INGESTION_COMPONENTS,
  INGESTION_LIMITS,
  INGESTION_PROFILE_VERSION,
} from "./contracts.js";

describe("isolated worker manifest", () => {
  it("keeps the checked-in worker policy aligned with the executable contract", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../worker/manifest.json", import.meta.url), "utf8"),
    ) as {
      allowedParsers: string[];
      components: Record<string, string>;
      disabledCapabilities: string[];
      limits: Record<string, number>;
      profile: string;
      runtime: Record<string, unknown>;
    };
    expect(manifest.profile).toBe(INGESTION_PROFILE_VERSION);
    expect(manifest.components).toEqual({
      ociRuntime: INGESTION_COMPONENTS.ociRuntime,
      ocrEngine: INGESTION_COMPONENTS.ocrEngine,
      ocrLanguage: INGESTION_COMPONENTS.ocrLanguage,
      parser: INGESTION_COMPONENTS.parser,
      scanner: `clamav-${INGESTION_COMPONENTS.clamAv}`,
    });
    expect(manifest.allowedParsers).toEqual(["pdf", "epub", "ooxml"]);
    expect(manifest.disabledCapabilities).toEqual(
      expect.arrayContaining([
        "ambient-credentials",
        "external-resources",
        "inline-ocr",
        "network",
        "remote-fetchers",
        "tika-server",
      ]),
    );
    expect(manifest.runtime).toMatchObject({
      capabilities: [],
      cpuCount: INGESTION_LIMITS.worker.cpuCount,
      memoryBytes: INGESTION_LIMITS.worker.memoryBytes,
      network: "none",
      pids: INGESTION_LIMITS.worker.maxPids,
      readOnlyRoot: true,
      seccomp: "podman-default",
      temporaryStorageBytes: INGESTION_LIMITS.worker.temporaryStorageBytes,
      user: "65532:65532",
    });
    expect(manifest.limits).toEqual({
      largeDocumentWallTimeMs: INGESTION_LIMITS.largeDocument.wallTimeMs,
      normalizedOutputBytes: INGESTION_LIMITS.normalizedOutputBytes,
      ocrPageTimeMs: INGESTION_LIMITS.ocrPageTimeMs,
      standardDocumentWallTimeMs: INGESTION_LIMITS.standardDocument.wallTimeMs,
    });
  });

  it("pins the parser build and keeps runtime parser selection explicit", () => {
    const pom = readFileSync(
      new URL("../worker/pom.xml", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL(
        "../worker/src/main/java/com/reflo/ingestion/WorkerMain.java",
        import.meta.url,
      ),
      "utf8",
    );

    expect(pom).toContain("<tika.version>3.3.1</tika.version>");
    expect(pom).toContain("<artifactId>tika-parser-pdf-module</artifactId>");
    expect(pom).toContain(
      "<artifactId>tika-parser-miscoffice-module</artifactId>",
    );
    expect(pom).toContain(
      "<artifactId>tika-parser-microsoft-module</artifactId>",
    );
    expect(workerSource).toContain("new PDFParser()");
    expect(workerSource).toContain("new EpubParser()");
    expect(workerSource).toContain("new OOXMLParser()");
    expect(workerSource).not.toMatch(
      /AutoDetectParser|DefaultParser|TikaServer/,
    );
  });
});
