import { describe, expect, it } from "vitest";

import {
  createP1FlagEvaluator,
  MAX_P1_TRUE_SNAPSHOT_MS,
  parseDeploymentCeiling,
} from "./evaluator.js";
import {
  P1_FLAG_KEYS,
  P1_FLAG_REGISTRY,
  P1_FLAG_REGISTRY_VERSION,
} from "./registry.js";
import {
  InMemoryPrerequisiteVerdictSource,
  InMemoryRequestedFlagStateSource,
  InMemoryResourceAdmissionSource,
} from "./testing.js";

describe("p1-flags-v1 registry", () => {
  it("is closed, immutable, and literally defaults every P1 capability off", () => {
    expect(Object.keys(P1_FLAG_REGISTRY).sort()).toEqual(
      [...P1_FLAG_KEYS].sort(),
    );
    for (const key of P1_FLAG_KEYS) {
      const definition = P1_FLAG_REGISTRY[key];
      expect(definition.default).toBe(false);
      expect(definition.registryVersion).toBe(P1_FLAG_REGISTRY_VERSION);
      expect(definition.prerequisitePolicy.requirements.length).toBeGreaterThan(
        0,
      );
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it("treats missing, wildcard, malformed, and unknown deployment entries as empty", () => {
    expect(parseDeploymentCeiling(undefined).status).toBe("missing");
    expect(parseDeploymentCeiling("*").status).toBe("invalid");
    expect(parseDeploymentCeiling("p1.media.video,unknown").status).toBe(
      "invalid",
    );
    expect(parseDeploymentCeiling("p1.media.video,").status).toBe("invalid");
    expect(parseDeploymentCeiling("p1.media.video").allowed).toEqual(
      new Set(["p1.media.video"]),
    );
  });
});

describe("trusted server P1 evaluation", () => {
  it("keeps all capabilities off without authoritative requested state", async () => {
    const sources = sourcesFixture();
    const evaluator = createP1FlagEvaluator({
      ...sources,
      deploymentCeiling: parseDeploymentCeiling(P1_FLAG_KEYS.join(",")),
      environment: "pilot",
      maxTrueSnapshotMs: 1_000,
    });

    for (const key of P1_FLAG_KEYS) {
      const context =
        key === "p1.media.video"
          ? { videoOperationKind: "chapter_explainer" as const }
          : {};
      await expect(evaluator.isEnabled(key, context)).resolves.toBe(false);
    }
    await expect(evaluator.isEnabled("p1.dynamic.unknown")).resolves.toBe(
      false,
    );
  });

  it("requires requested state, deployment allowance, current evidence, and shared admission", async () => {
    const now = 1_000;
    const sources = sourcesFixture();
    const definition = P1_FLAG_REGISTRY["p1.tutor.voice"];
    sources.requestedStateSource.set("pilot", "p1.tutor.voice", {
      requestedEnabled: true,
      revision: 7,
    });
    sources.prerequisiteSource.satisfy(
      "pilot",
      definition.prerequisitePolicy,
      now + 10_000,
    );
    const evaluator = createP1FlagEvaluator({
      ...sources,
      deploymentCeiling: parseDeploymentCeiling("p1.tutor.voice"),
      environment: "pilot",
      maxTrueSnapshotMs: 1_000,
      now: () => now,
    });

    await expect(evaluator.evaluate("p1.tutor.voice")).resolves.toEqual({
      enabled: true,
      evaluatedAtMs: now,
      requestedRevision: 7,
    });
    sources.admissionSource.admitted = false;
    evaluator.invalidate("p1.tutor.voice");
    await expect(evaluator.evaluate("p1.tutor.voice")).resolves.toEqual({
      enabled: false,
      reason: "admission_denied",
    });
  });

  it("requires a closed video operation and separate full-course exit evidence", async () => {
    const now = 2_000;
    const sources = sourcesFixture();
    const definition = P1_FLAG_REGISTRY["p1.media.video"];
    sources.requestedStateSource.set("staging", "p1.media.video", {
      requestedEnabled: true,
      revision: 2,
    });
    sources.prerequisiteSource.satisfy(
      "staging",
      definition.prerequisitePolicy,
      now + 10_000,
    );
    const evaluator = createP1FlagEvaluator({
      ...sources,
      deploymentCeiling: parseDeploymentCeiling("p1.media.video"),
      environment: "staging",
      maxTrueSnapshotMs: 1_000,
      now: () => now,
    });

    await expect(evaluator.evaluate("p1.media.video")).resolves.toEqual({
      enabled: false,
      reason: "video_operation_invalid",
    });
    await expect(
      evaluator.evaluate("p1.media.video", {
        videoOperationKind: "full_course",
      }),
    ).resolves.toEqual({
      enabled: false,
      reason: "prerequisite_missing_or_stale",
    });

    const fullCoursePolicy = definition.videoOperationPolicies?.full_course;
    expect(fullCoursePolicy).toBeDefined();
    sources.prerequisiteSource.satisfy(
      "staging",
      fullCoursePolicy!,
      now + 10_000,
    );
    await expect(
      evaluator.isEnabled("p1.media.video", {
        videoOperationKind: "full_course",
      }),
    ).resolves.toBe(true);
  });

  it("expires cached true snapshots and fails closed when authority is unavailable", async () => {
    let now = 3_000;
    const sources = sourcesFixture();
    const definition = P1_FLAG_REGISTRY["p1.auth.oauth"];
    sources.requestedStateSource.set("dev", "p1.auth.oauth", {
      requestedEnabled: true,
      revision: 1,
    });
    sources.prerequisiteSource.satisfy(
      "dev",
      definition.prerequisitePolicy,
      now + 10_000,
    );
    const evaluator = createP1FlagEvaluator({
      ...sources,
      deploymentCeiling: parseDeploymentCeiling("p1.auth.oauth"),
      environment: "dev",
      maxTrueSnapshotMs: 50,
      now: () => now,
    });
    await expect(evaluator.isEnabled("p1.auth.oauth")).resolves.toBe(true);

    sources.requestedStateSource.read = async () => {
      throw new Error("database unavailable");
    };
    await expect(evaluator.isEnabled("p1.auth.oauth")).resolves.toBe(true);
    now += 51;
    await expect(evaluator.evaluate("p1.auth.oauth")).resolves.toEqual({
      enabled: false,
      reason: "source_unavailable",
    });
  });

  it("never caches true beyond the current prerequisite evidence", async () => {
    let now = 4_000;
    const sources = sourcesFixture();
    const definition = P1_FLAG_REGISTRY["p1.auth.oauth"];
    sources.requestedStateSource.set("dev", "p1.auth.oauth", {
      requestedEnabled: true,
      revision: 3,
    });
    sources.prerequisiteSource.satisfy(
      "dev",
      definition.prerequisitePolicy,
      now + 10,
    );
    const evaluator = createP1FlagEvaluator({
      ...sources,
      deploymentCeiling: parseDeploymentCeiling("p1.auth.oauth"),
      environment: "dev",
      maxTrueSnapshotMs: 1_000,
      now: () => now,
    });

    await expect(evaluator.isEnabled("p1.auth.oauth")).resolves.toBe(true);
    now += 10;
    await expect(evaluator.evaluate("p1.auth.oauth")).resolves.toEqual({
      enabled: false,
      reason: "prerequisite_missing_or_stale",
    });
  });

  it("rejects caller staleness bounds above the checked-in maximum", () => {
    const sources = sourcesFixture();
    expect(() =>
      createP1FlagEvaluator({
        ...sources,
        deploymentCeiling: parseDeploymentCeiling("p1.auth.oauth"),
        environment: "dev",
        maxTrueSnapshotMs: MAX_P1_TRUE_SNAPSHOT_MS + 1,
      }),
    ).toThrow(`between 1 and ${MAX_P1_TRUE_SNAPSHOT_MS}`);
  });
});

function sourcesFixture() {
  return {
    admissionSource: new InMemoryResourceAdmissionSource(),
    prerequisiteSource: new InMemoryPrerequisiteVerdictSource(),
    requestedStateSource: new InMemoryRequestedFlagStateSource(),
  };
}
