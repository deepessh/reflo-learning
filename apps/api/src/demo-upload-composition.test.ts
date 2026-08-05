import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDemoUploadRuntime,
  demoUploadOperationLeaseMs,
} from "./demo-upload-composition.js";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("serverless demo upload composition", () => {
  it("keeps durable ingestion leases beyond each accepted worker bound", () => {
    expect(
      demoUploadOperationLeaseMs("local-isolated-ingestion-bridge-v1"),
    ).toBe(180_000);
    expect(demoUploadOperationLeaseMs("serverless-isolated-ingestion-v1")).toBe(
      1_800_000,
    );
    expect(() => demoUploadOperationLeaseMs("disabled")).toThrow(
      "processor mode is not allowlisted",
    );
  });

  it("rejects the FC parser outside the owner-approved Singapore region before cloud access", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "reflo-serverless-composition-"),
    );
    temporaryDirectories.push(artifactRoot);

    await expect(
      createDemoUploadRuntime(
        {
          DATABASE_URL: "postgresql://unused",
          REFLO_ALIBABA_REGION: "us-west-1",
          REFLO_CONNECTED_DEMO_ARTIFACT_ROOT: artifactRoot,
          REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE:
            "staff-controlled-rights-cleared-v1",
          REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
          REFLO_DEMO_OPERATOR_OWNER_SCOPE_ID:
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          REFLO_DEMO_OPERATOR_USER_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          REFLO_DEMO_UPLOAD_PROCESSOR_MODE: "serverless-isolated-ingestion-v1",
          REFLO_ENV: "dev",
          REFLO_VECTOR_DATABASE_URL: "postgresql://unused",
        },
        "dev",
      ),
    ).rejects.toThrow("approved only in Singapore");
  });
});
