import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  NODE_IMAGE,
  collectApplicationContainerViolations,
  validateRepositoryApplicationContainers,
} from "./check-app-containers.mjs";

const root = process.cwd();
const valid = {
  composeSource: readFileSync(path.join(root, "compose.yaml"), "utf8"),
  dockerfiles: Object.fromEntries(
    ["api", "jobs", "web"].map((app) => [
      app,
      readFileSync(path.join(root, "apps", app, "Dockerfile"), "utf8"),
    ]),
  ),
  dockerignoreSource: readFileSync(path.join(root, ".dockerignore"), "utf8"),
  lifecycleSource: readFileSync(
    path.join(root, "scripts/local-apps.sh"),
    "utf8",
  ),
};

describe("application container policy", () => {
  it("accepts the checked-in images, profile, and lifecycle", () => {
    assert.deepEqual(validateRepositoryApplicationContainers(root), []);
  });

  it("rejects toolchain drift and cross-application packaging", () => {
    const dockerfiles = {
      ...valid.dockerfiles,
      api: valid.dockerfiles.api
        .replace(NODE_IMAGE, "node:24-bookworm-slim")
        .replace("pnpm@10.34.5", "pnpm@latest")
        .replace("--filter @reflo/api", "--filter @reflo/web"),
    };
    const errors = collectApplicationContainerViolations({
      ...valid,
      dockerfiles,
    });

    assert.ok(
      errors.includes(
        "apps/api/Dockerfile must use only the exact pinned Node image in both stages",
      ),
    );
    assert.ok(errors.includes("missing apps/api exact pnpm activation"));
    assert.ok(errors.includes("missing apps/api independent workspace build"));
    assert.ok(
      errors.includes(
        "apps/api/Dockerfile must not package the web application",
      ),
    );
  });

  it("rejects secret build inputs and exposed or unhealthy services", () => {
    const dockerfiles = {
      ...valid.dockerfiles,
      jobs: `${valid.dockerfiles.jobs}\nARG PROVIDER_TOKEN\n`,
    };
    const composeSource = valid.composeSource
      .replace(
        '"127.0.0.1:${REFLO_LOCAL_API_PORT:-53001}:3001"',
        '"0.0.0.0:53001:3001"',
      )
      .replace(/(  api:\n[\s\S]*?)    healthcheck:/, "$1    readiness:");
    const errors = collectApplicationContainerViolations({
      ...valid,
      composeSource,
      dockerfiles,
    });

    assert.ok(
      errors.includes(
        "apps/jobs/Dockerfile must not declare credential inputs",
      ),
    );
    assert.ok(errors.includes("missing api loopback-only host port"));
    assert.ok(errors.includes("missing api Compose health check"));
  });

  it("rejects broad or user-directed lifecycle cleanup", () => {
    const lifecycleSource = `${valid.lifecycleSource}\ndocker system prune\nrun_compose "$@"\n`;
    const errors = collectApplicationContainerViolations({
      ...valid,
      lifecycleSource,
    });

    assert.ok(
      errors.includes(
        "application lifecycle must not accept arbitrary Compose arguments or remove unrelated Docker resources",
      ),
    );
  });
});
