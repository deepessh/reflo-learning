import type { Deployment } from "@reflo/config";
import { PostgresDemoUploadRepository } from "@reflo/db";
import { LocalSmokeObjectStore } from "@reflo/dev-smoke";

import {
  APPROVED_AGENTS_COURSE_SOURCE,
  ApprovedDemoUploadService,
} from "./demo-upload.js";

const CONNECTED_MODE = "staff-only-demo-v1";
const CONNECTED_BOUNDARY_PROFILE = "staff-controlled-rights-cleared-v1";

export interface DemoUploadRuntime {
  readonly demoUploads?: ApprovedDemoUploadService;
  close(): Promise<void>;
}

export function createDemoUploadRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): DemoUploadRuntime {
  const mode = input.REFLO_CONNECTED_DEMO_MODE;
  if (mode === undefined || mode === "disabled") {
    return { close: async () => undefined };
  }
  if (
    mode !== CONNECTED_MODE ||
    input.REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE !== CONNECTED_BOUNDARY_PROFILE
  ) {
    throw new Error("demo upload requires the connected demo boundary");
  }
  if (deployment !== "dev" || input.REFLO_ENV !== "dev") {
    throw new Error("local demo upload composition is development-only");
  }
  const databaseUrl = required(input, "DATABASE_URL");
  const artifactRoot = required(input, "REFLO_CONNECTED_DEMO_ARTIFACT_ROOT");
  const operatorUserId = requiredUuid(input, "REFLO_DEMO_OPERATOR_USER_ID");
  const repository = new PostgresDemoUploadRepository(databaseUrl, {
    environment: deployment,
  });
  return {
    demoUploads: new ApprovedDemoUploadService({
      approvals: [APPROVED_AGENTS_COURSE_SOURCE],
      objects: new LocalSmokeObjectStore(artifactRoot),
      operatorUserIds: [operatorUserId],
      repository,
    }),
    close: () => repository.close(),
  };
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredUuid(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
