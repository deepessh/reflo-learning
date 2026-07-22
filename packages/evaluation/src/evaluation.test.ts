import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GateAttestationPublisher,
  isAttestationCurrent,
} from "./attestation.js";
import type {
  AdversarialDatasetItem,
  AdversarialObservation,
  AudioObservation,
  AudioScriptDatasetItem,
  DatasetItem,
  DatasetManifest,
  GateRun,
  GateRunMetadata,
  PerformanceObservation,
  ReleaseGateId,
  UploadSecurityDatasetItem,
  UploadSecurityObservation,
} from "./contracts.js";
import {
  canonicalJson,
  createEvidenceBundle,
  githubSafeSummary,
  verifyEvidenceBundle,
} from "./evidence.js";
import { GATE_CONTRACTS } from "./gate-contracts.js";
import { runPerformanceDataset } from "./runner.js";
import { scoreGate } from "./scoring.js";
import {
  FixedPublisherAuthorization,
  InMemoryGateAttestationIndex,
} from "./testing.js";
import { validateDatasetManifest } from "./validation.js";

const DIGEST = "a".repeat(64);
const START = "2026-07-21T16:00:00.000Z";
const END = "2026-07-21T17:00:00.000Z";

describe("evaluation-contract-v1 schemas and manifests", () => {
  it("checks in the versioned JSON schemas", () => {
    for (const [name, title] of [
      [
        "audio-listening-review-v1.schema.json",
        "Reflo audio-listening-review-v1",
      ],
      ["dataset-manifest-v1.schema.json", "Reflo dataset-manifest-v1"],
      ["evidence-bundle-v1.schema.json", "Reflo evidence-bundle-v1"],
      ["gate-attestation-v1.schema.json", "Reflo gate-attestation-v1"],
    ]) {
      const schema = JSON.parse(
        readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
      ) as { readonly title: string };
      expect(schema.title).toBe(title);
    }
  });

  it("rejects duplicate membership, digest drift, and absent rights", () => {
    const item = performanceItems()[0]!;
    expect(
      validateDatasetManifest(
        manifest("week1.performance", [item, { ...item, sha256: "changed" }]),
      ),
    ).toEqual(
      expect.arrayContaining([
        "dataset_item_digest_invalid",
        "dataset_item_identity_invalid_or_duplicate",
      ]),
    );
    expect(
      validateDatasetManifest(
        manifest("week1.performance", [item], {
          rightsApprovalReferences: [],
        }),
      ),
    ).toContain("rights_approval_missing_or_invalid");
  });

  it("keeps fixture datasets incapable of issuing an authoritative pass", () => {
    const input = manifest("week1.performance", performanceItems(), {
      authority: "fixture",
    });
    const result = scoreGate(input, performanceRun(input));
    expect(result).toMatchObject({
      reasons: expect.arrayContaining(["fixture_dataset_is_not_authoritative"]),
      status: "indeterminate",
    });
  });
});

describe("deterministic Week 1 scoring", () => {
  it("passes the 40-document, three-run, cold-cache performance profile", () => {
    const input = manifest("week1.performance", performanceItems());
    const scored = scoreGate(input, performanceRun(input));
    expect(scored).toMatchObject({
      metrics: {
        activationP95Ms: 240_000,
        audioP95Ms: 540_000,
        outlineP95Ms: 90_000,
        sampleRuns: 120,
      },
      misses: [],
      status: "passed",
    });
  });

  it("counts timeouts as misses and fails usability assertions", () => {
    const input = manifest("week1.performance", performanceItems());
    const run = performanceRun(input);
    const observations = [...run.observations];
    observations[0] = {
      ...observations[0]!,
      activationPackageMs: null,
      activationPackageUsable: false,
      audioMs: null,
      outcome: "timed-out",
      outlineMs: null,
    };
    const scored = scoreGate(input, { ...run, observations });
    expect(scored.status).toBe("failed");
    expect(scored.misses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "timed-out" }),
        expect.objectContaining({ reason: "usability_assertion_failed" }),
      ]),
    );
  });

  it("counts failed observations as misses even when they report latencies", () => {
    const input = manifest("week1.performance", performanceItems());
    const run = performanceRun(input);
    const observations = [...run.observations];
    observations[0] = { ...observations[0]!, outcome: "failed" };
    const scored = scoreGate(input, { ...run, observations });
    expect(scored.misses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: observations[0]!.itemId,
          reason: "failed",
        }),
      ]),
    );
  });

  it("passes both audio paths only with 30 scripts, five courses, and two reviewers", () => {
    const input = manifest("week1.audio", audioItems());
    const run: GateRun<AudioObservation> = {
      gateId: "week1.audio",
      metadata: metadata("week1.audio"),
      observations: audioItems().flatMap((item) =>
        (["qwen-tts.primary", "piper-tts.cpu"] as const).map((adapter) => ({
          adapter,
          authorizedPrivateAsset: true,
          diagnostics: [],
          itemId: item.id,
          latencyMs: 300_000,
          listeningReviews: [
            {
              intelligibleAt1_5x: true,
              intelligibleAt1x: true,
              reviewSchemaVersion: "audio-listening-review-v1",
              reviewerId: "reviewer-0001",
            },
            {
              intelligibleAt1_5x: true,
              intelligibleAt1x: true,
              reviewSchemaVersion: "audio-listening-review-v1",
              reviewerId: "reviewer-0002",
            },
          ],
          outcome: "succeeded",
          playable: true,
          rangePlayback: true,
          retries: 0,
        })),
      ),
    };
    expect(scoreGate(input, run).status).toBe("passed");
    const incomplete = [...run.observations];
    incomplete[0] = { ...incomplete[0]!, listeningReviews: [] };
    expect(
      scoreGate(input, { ...run, observations: incomplete }),
    ).toMatchObject({ status: "indeterminate" });
    const failed = [...run.observations];
    failed[0] = {
      ...failed[0]!,
      listeningReviews: failed[0]!.listeningReviews.map((review, index) => ({
        ...review,
        intelligibleAt1_5x: index !== 0,
      })),
    };
    expect(scoreGate(input, { ...run, observations: failed }).status).toBe(
      "failed",
    );
  });

  it("enforces every upload route, owner scope, isolation, and idempotent retry", () => {
    const items = uploadItems();
    const input = manifest("week1.upload-security", items);
    const observations: UploadSecurityObservation[] = items.map((item) => ({
      actualOutcome: item.expectedOutcome,
      ambientCredentialsAbsent: true,
      diagnostics: [],
      idempotentRetry: true,
      itemId: item.id,
      networkDenied: true,
      outcome: "succeeded",
      ownerScopeEnforced: true,
      retries: 1,
    }));
    const run: GateRun<UploadSecurityObservation> = {
      gateId: "week1.upload-security",
      metadata: metadata("week1.upload-security"),
      observations,
    };
    expect(scoreGate(input, run).status).toBe("passed");
    observations[0] = { ...observations[0]!, ownerScopeEnforced: false };
    expect(scoreGate(input, run)).toMatchObject({ status: "failed" });
  });

  it("applies zero tolerance to all 20 adversarial documents", () => {
    const items = adversarialItems();
    const input = manifest("week1.adversarial", items);
    const observations: AdversarialObservation[] = items.map((item) => ({
      authorizationPolicyChanged: false,
      citationResolvedToAuthorizedSpan: true,
      crossScopeDisclosure: false,
      diagnostics: [],
      gradingPolicyChanged: false,
      itemId: item.id,
      outcome: "succeeded",
      retries: 0,
      sourceInstructionExecuted: false,
      toolPolicyChanged: false,
    }));
    const run: GateRun<AdversarialObservation> = {
      gateId: "week1.adversarial",
      metadata: metadata("week1.adversarial"),
      observations,
    };
    expect(scoreGate(input, run).status).toBe("passed");
    observations[0] = { ...observations[0]!, crossScopeDisclosure: true };
    expect(scoreGate(input, run)).toMatchObject({
      reasons: ["zero_tolerance_security_failure"],
      status: "failed",
    });
  });
});

describe("portable runners and evidence", () => {
  it("runs the complete performance matrix with concurrency exactly five", async () => {
    const input = manifest("week1.performance", performanceItems());
    let active = 0;
    let peak = 0;
    const observations = await runPerformanceDataset(input, 3, {
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        active -= 1;
        return {
          activationPackageMs: 240_000,
          activationPackageUsable: true,
          audioMs: 540_000,
          audioPlayableAuthorized: true,
          diagnostics: [],
          outlineMs: 90_000,
          outlineUsable: true,
          outcome: "succeeded" as const,
          retries: 0,
        };
      },
    });
    expect(observations).toHaveLength(120);
    expect(peak).toBe(5);
  });

  it("records executor failures instead of dropping unfavorable samples", async () => {
    const input = manifest("week1.performance", performanceItems());
    let calls = 0;
    const observations = await runPerformanceDataset(input, 3, {
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("unbounded provider detail must not escape");
        }
        return {
          activationPackageMs: 240_000,
          activationPackageUsable: true,
          audioMs: 540_000,
          audioPlayableAuthorized: true,
          diagnostics: [],
          outlineMs: 90_000,
          outlineUsable: true,
          outcome: "succeeded" as const,
          retries: 0,
        };
      },
    });
    expect(observations).toHaveLength(120);
    expect(observations).toContainEqual(
      expect.objectContaining({
        diagnostics: ["executor_failure"],
        outcome: "failed",
      }),
    );
  });

  it("produces deterministic, content-addressed, bounded evidence", () => {
    const input = manifest("week1.performance", performanceItems());
    const run = performanceRun(input);
    const scored = scoreGate(input, run);
    const first = createEvidenceBundle(input, run, scored);
    const second = createEvidenceBundle(input, run, scored);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(verifyEvidenceBundle(first)).toBe(true);
    expect(githubSafeSummary(first)).toContain("misses=0");
    const tampered = { ...first, datasetVersion: "changed" };
    expect(verifyEvidenceBundle(tampered)).toBe(false);
    const unsafeRun = {
      ...run,
      observations: [
        { ...run.observations[0]!, diagnostics: ["person@example.com"] },
        ...run.observations.slice(1),
      ],
    };
    expect(() => createEvidenceBundle(input, unsafeRun, scored)).toThrow(
      "unsafe_evidence_value",
    );
  });
});

describe("authorized fail-closed attestations", () => {
  it("publishes a current passing attestation and invalidates dependency drift", async () => {
    const input = manifest("week1.performance", performanceItems());
    const run = performanceRun(input);
    const bundle = createEvidenceBundle(input, run, scoreGate(input, run));
    const index = new InMemoryGateAttestationIndex();
    const publisher = new GateAttestationPublisher(
      new FixedPublisherAuthorization(true),
      index,
    );
    const attestation = await publisher.publish({
      bundle,
      evidenceBundleReference: "oss-evidence:sha256/fixture-bundle",
      publishedAt: END,
      publisherAuthorizationReference: "issue:35-publisher-authorization",
      publisherId: "release-publisher-01",
    });
    expect(attestation.status).toBe("passed");
    expect(
      isAttestationCurrent(attestation, {
        dependencyFingerprints: run.metadata.dependencyFingerprints,
        deployableArtifactDigest: run.metadata.deployableArtifactDigest,
        environment: "staging",
        evidenceBundleAvailable: true,
        now: "2026-07-22T00:00:00.000Z",
        supersededByLaterRun: false,
      }),
    ).toBe(true);
    expect(
      isAttestationCurrent(attestation, {
        dependencyFingerprints: {
          ...run.metadata.dependencyFingerprints,
          schema: "b".repeat(64),
        },
        deployableArtifactDigest: run.metadata.deployableArtifactDigest,
        environment: "staging",
        evidenceBundleAvailable: true,
        now: "2026-07-22T00:00:00.000Z",
        supersededByLaterRun: false,
      }),
    ).toBe(false);
  });

  it("rejects unauthorized publishers", async () => {
    const input = manifest("week1.performance", performanceItems());
    const run = performanceRun(input);
    const bundle = createEvidenceBundle(input, run, scoreGate(input, run));
    const publisher = new GateAttestationPublisher(
      new FixedPublisherAuthorization(false),
      new InMemoryGateAttestationIndex(),
    );
    await expect(
      publisher.publish({
        bundle,
        evidenceBundleReference: "oss-evidence:sha256/fixture-bundle",
        publishedAt: END,
        publisherAuthorizationReference: "issue:35-publisher-authorization",
        publisherId: "release-publisher-01",
      }),
    ).rejects.toThrow("attestation_publisher_unauthorized");
  });
});

function manifest(
  gateId: ReleaseGateId,
  items: readonly DatasetItem[],
  overrides: Partial<DatasetManifest> = {},
): DatasetManifest {
  return {
    authority: "authoritative",
    contractVersion: "evaluation-contract-v1",
    datasetId: `${gateId}.dataset`,
    datasetVersion: "2026-07-21-v1",
    heldOut: true,
    intendedGates: [gateId],
    items,
    manifestSchemaVersion: "dataset-manifest-v1",
    preRunExclusions: [],
    protocols: {
      adjudication: "adjudication-v1",
      annotation: "annotation-v1",
      reviewer: "reviewer-v1",
      rubric: "rubric-v1",
    },
    rightsApprovalReferences: [
      ...new Set(items.map((item) => item.rightsApprovalReference)),
    ],
    selection: { method: "predeclared-stratified-v1", seed: 35 },
    ...overrides,
  };
}

function metadata(gateId: ReleaseGateId): GateRunMetadata {
  const contract = GATE_CONTRACTS[gateId];
  const mutableKinds = new Set(contract.requiredMutableEvidenceKinds);
  return {
    cacheProfile: { application: "cold", model: "cold" },
    completedAt: END,
    concurrency: 5,
    declaredSeed: 35,
    dependencyFingerprints: Object.fromEntries(
      contract.requiredDependencyKeys.map((key) => [key, DIGEST]),
    ),
    deployableArtifactDigest: `sha256:${DIGEST}`,
    environment: "staging",
    executionBoundary: contract.allowedExecutionBoundaries.includes(
      "target-production",
    )
      ? "target-production"
      : "production-equivalent",
    infrastructureFingerprint: `sha256:${DIGEST}`,
    mutableEvidence: [...mutableKinds].map((kind) => ({
      kind: kind as "capacity" | "legal" | "privacy" | "quota" | "rights",
      reference: `issue:35-${kind}-evidence`,
      status: "valid" as const,
      validUntil: "2026-08-07T00:00:00.000Z",
    })),
    repetitions: contract.minimumRepetitions,
    runId: `${gateId}.run-001`,
    sourceCommit: "a".repeat(40),
    startedAt: START,
  };
}

function performanceRun(
  input: DatasetManifest,
): GateRun<PerformanceObservation> {
  const repetitions = 3;
  return {
    gateId: "week1.performance",
    metadata: { ...metadata("week1.performance"), repetitions },
    observations: input.items
      .filter((item) => item.kind === "document")
      .flatMap((item) =>
        Array.from({ length: repetitions }, (_, index) => ({
          activationPackageMs: 240_000,
          activationPackageUsable: true,
          audioMs: 540_000,
          audioPlayableAuthorized: true,
          diagnostics: [],
          itemId: item.id,
          outlineMs: 90_000,
          outlineUsable: true,
          outcome: "succeeded" as const,
          repetition: index + 1,
          retries: 0,
        })),
      ),
  };
}

function performanceItems(): readonly DatasetItem[] {
  const required = GATE_CONTRACTS["week1.performance"].requiredStrata;
  return Array.from({ length: 40 }, (_, index) => {
    const format = (["pdf", "epub", "docx"] as const)[index % 3]!;
    const byteLength = 512 * 1_024 + index * 500_000;
    const pageCount = format === "pdf" ? Math.min(200, 5 + index * 5) : null;
    return {
      byteLength,
      complexity: index % 2 === 0 ? "simple" : "complex",
      format,
      hasImages: index % 3 === 0,
      hasTables: index % 4 === 0,
      id: `performance-document-${String(index).padStart(3, "0")}`,
      kind: "document" as const,
      pageCount,
      rightsApprovalReference: "issue:36-content-rights",
      sha256: index.toString(16).padStart(64, "0"),
      standardProfileEligibilityReference: "prd:standard-profile-v1",
      strata: [
        ...new Set([
          ...(index === 0 ? required : []),
          `format:${format}`,
          `structure:${index % 2 === 0 ? "simple" : "complex"}`,
          ...(index % 3 === 0 ? ["content:images"] : []),
          ...(index % 4 === 0 ? ["content:tables"] : []),
          ...(byteLength < 5 * 1_024 * 1_024
            ? ["size:0.5-4.9mb"]
            : byteLength < 15 * 1_024 * 1_024
              ? ["size:5-14.9mb"]
              : ["size:15-20mb"]),
          ...(pageCount === null
            ? []
            : pageCount < 50
              ? ["pages:5-49"]
              : pageCount < 150
                ? ["pages:50-149"]
                : ["pages:150-200"]),
        ]),
      ],
    };
  });
}

function audioItems(): readonly AudioScriptDatasetItem[] {
  return Array.from({ length: 30 }, (_, index) => ({
    courseId: `course-${String(index % 5).padStart(3, "0")}`,
    id: `audio-script-${String(index).padStart(3, "0")}`,
    kind: "audio-script",
    rightsApprovalReference: "issue:36-content-rights",
    scriptByteLength: 2_000,
    sha256: index.toString(16).padStart(64, "0"),
    strata: ["script:representative"],
  }));
}

function uploadItems(): readonly UploadSecurityDatasetItem[] {
  return GATE_CONTRACTS["week1.upload-security"].requiredStrata.map(
    (stratum, index) => ({
      expectedOutcome: stratum.startsWith("format:") ? "parsed" : stratum,
      id: `upload-case-${String(index).padStart(3, "0")}`,
      kind: "upload-security",
      rightsApprovalReference: "fixture:synthetic-rights",
      sha256: index.toString(16).padStart(64, "0"),
      strata: [stratum],
    }),
  );
}

function adversarialItems(): readonly AdversarialDatasetItem[] {
  const threats = [
    "cross-scope-reference",
    "fake-citation",
    "grading-manipulation",
    "indirect-prompt-injection",
    "tool-use-request",
  ] as const;
  return Array.from({ length: 20 }, (_, index) => {
    const threat = threats[index % threats.length]!;
    return {
      id: `adversarial-document-${String(index).padStart(3, "0")}`,
      kind: "adversarial-document",
      rightsApprovalReference: "fixture:synthetic-rights",
      sha256: index.toString(16).padStart(64, "0"),
      strata: [`threat:${threat}`],
      threatClasses: [threat],
    };
  });
}
