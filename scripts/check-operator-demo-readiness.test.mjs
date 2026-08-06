import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertOperatorDemoReady,
  collectOperatorDemoReadiness,
  localUploadIdentityResult,
} from "./check-operator-demo-readiness.mjs";

const origins = {
  apiOrigin: new URL("http://127.0.0.1:53001"),
  jobsOrigin: new URL("http://127.0.0.1:53002"),
  webOrigin: new URL("http://127.0.0.1:53000"),
};

describe("operator-hosted demo readiness", () => {
  it("requires live services, staff auth, and every connected dependency", async () => {
    const results = await collectOperatorDemoReadiness({
      ...origins,
      fetchImpl: readyFetch,
    });

    assert.equal(assertOperatorDemoReady(results), results);
    assert.deepEqual(
      results.map((result) => result.component),
      ["web", "api", "jobs", "staff-auth", "connected-dependencies"],
    );
  });

  it("fails closed for disabled auth or any unavailable dependency", async () => {
    const disabledAuth = await collectOperatorDemoReadiness({
      ...origins,
      fetchImpl: async (url) =>
        new URL(url).pathname === "/v1/account"
          ? jsonResponse(404, { error: "not_found" })
          : readyFetch(url),
    });
    const unavailableModel = await collectOperatorDemoReadiness({
      ...origins,
      fetchImpl: async (url) => {
        if (new URL(url).pathname !== "/v1/demo/preflight") {
          return readyFetch(url);
        }
        const body = preflight();
        body.status = "unavailable";
        body.dependencies[1].code = "unavailable";
        return jsonResponse(503, body);
      },
    });

    assert.throws(() => assertOperatorDemoReady(disabledAuth));
    assert.throws(() => assertOperatorDemoReady(unavailableModel));
  });

  it("fails closed for malformed or oversized diagnostics", async () => {
    await assert.rejects(
      collectOperatorDemoReadiness({
        ...origins,
        fetchImpl: async () =>
          new Response("x".repeat(65 * 1024), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      }),
      /response_too_large/,
    );
  });

  it("requires the API upload identities to match the prepared worker profile", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const snapshot = `cvd-${"b".repeat(32)}`;
    const runtime = [
      "REFLO_DEMO_UPLOAD_PROCESSOR_MODE=local-isolated-ingestion-bridge-v1",
      `REFLO_LOCAL_CLAMAV_SNAPSHOT_ID=${snapshot}`,
      `REFLO_LOCAL_INGESTION_IMAGE_DIGEST=${digest}`,
    ].join("\n");
    const workers = [
      `REFLO_LOCAL_CLAMAV_SNAPSHOT_ID='${snapshot}'`,
      `REFLO_LOCAL_INGESTION_IMAGE_DIGEST='${digest}'`,
    ].join("\n");

    assert.deepEqual(localUploadIdentityResult(runtime, workers), {
      available: true,
      component: "upload-identities",
    });
    assert.deepEqual(
      localUploadIdentityResult(
        runtime,
        workers.replace(digest, `sha256:${"c".repeat(64)}`),
      ),
      { available: false, component: "upload-identities" },
    );
  });
});

async function readyFetch(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/health") {
    const service =
      parsed.port === "53000"
        ? "web"
        : parsed.port === "53001"
          ? "api"
          : "jobs";
    return jsonResponse(200, {
      contractVersion: 1,
      ...(service === "web" ? {} : { environment: "dev" }),
      service,
      status: "ok",
    });
  }
  if (parsed.pathname === "/v1/account") {
    return jsonResponse(401, { error: "authentication_required" });
  }
  return jsonResponse(200, preflight());
}

function preflight() {
  return {
    boundary: {
      destinationClass: "staff-controlled-test",
      learnerClass: "staff-controlled",
      sourceClass: "human-approved-rights-cleared",
    },
    contractVersion: "connected-demo-preflight-v1",
    dependencies: ["delivery", "model", "postgres", "storage", "vector"].map(
      (name) => ({ code: "available", contractVersion: `${name}-v1`, name }),
    ),
    status: "ready",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
