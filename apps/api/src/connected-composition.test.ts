import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConnectedDemoRuntime,
  type ConnectedDemoRuntime,
} from "./connected-composition.js";

const runtimes: ConnectedDemoRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  vi.unstubAllGlobals();
});

describe("connected demo composition", () => {
  it("injects real runtime services and reports bounded dependency states", async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "reflo-connected-api-"),
    );
    directories.push(artifactRoot);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"data":[]}', {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    const runtime = await createConnectedDemoRuntime(
      developmentEnvironment(artifactRoot),
      "dev",
    );
    runtimes.push(runtime);

    expect(runtime.assessment).toBeDefined();
    expect(runtime.study).toBeDefined();
    expect(runtime.tutorAgent).toBeDefined();
    expect(runtime.sessions).toBeDefined();
    await expect(runtime.preflight!.check(false)).resolves.toMatchObject({
      boundary: {
        contractVersion: "connected-demo-boundary-v1",
        destinationClass: "staff-controlled-test",
        learnerClass: "staff-controlled",
        sourceClass: "human-approved-rights-cleared",
      },
      dependencies: [
        { code: "unavailable", name: "delivery" },
        { code: "available", name: "model" },
        { code: "unavailable", name: "postgres" },
        { code: "available", name: "storage" },
        { code: "unavailable", name: "vector" },
      ],
      status: "unavailable",
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    runtimes.pop();
  });

  it("rejects development model descriptors in staging and pilot", async () => {
    for (const deployment of ["pilot", "staging"] as const) {
      await expect(
        createConnectedDemoRuntime(
          {
            REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE:
              "staff-controlled-rights-cleared-v1",
            REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
            REFLO_ENV: deployment,
            REFLO_MODEL_ADAPTER: "litellm-dev",
          },
          deployment,
        ),
      ).rejects.toThrow("development-only");
    }
  });

  it("fails closed without an explicit staff and source boundary profile", async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "reflo-connected-api-"),
    );
    directories.push(artifactRoot);
    const environment = developmentEnvironment(artifactRoot);
    delete environment.REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE;

    await expect(
      createConnectedDemoRuntime(environment, "dev"),
    ).rejects.toThrow(
      "must attest the staff-controlled rights-cleared demo boundary",
    );
  });
});

function developmentEnvironment(artifactRoot: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://127.0.0.1:1/reflo",
    REFLO_CONNECTED_DEMO_ARTIFACT_ROOT: artifactRoot,
    REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE: "staff-controlled-rights-cleared-v1",
    REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
    REFLO_CONNECTED_DEMO_OBJECT_STORE: "local-filesystem-v1",
    REFLO_DEMO_GRADING_CALIBRATION_EVIDENCE_ID:
      "synthetic-demo-calibration-fixture-v1",
    REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD: "0.95000",
    REFLO_DEMO_REVIEW_LOCAL_TIME: "09:00",
    REFLO_DEMO_REVIEW_TIME_ZONE: "UTC",
    REFLO_DEMO_SEED_COURSE_ID: "50000000-0000-4000-8000-000000000162",
    REFLO_DEMO_TRACING_MODE: "disabled",
    REFLO_ENV: "dev",
    REFLO_LITELLM_API_KEY: "dev-only-placeholder",
    REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4000",
    REFLO_LITELLM_EMBEDDING_MODEL: "reflo-local-embedding",
    REFLO_LITELLM_TEXT_MODEL: "reflo-local-text",
    REFLO_MODEL_ADAPTER: "litellm-dev",
    REFLO_VECTOR_DATABASE_URL: "postgresql://127.0.0.1:1/reflo_vectors",
  };
}
