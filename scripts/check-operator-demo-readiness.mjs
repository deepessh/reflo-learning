import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const REQUIRED_DEPENDENCIES = [
  "delivery",
  "model",
  "postgres",
  "storage",
  "vector",
];

export async function collectOperatorDemoReadiness({
  apiOrigin,
  fetchImpl = fetch,
  jobsOrigin,
  webOrigin,
}) {
  const results = [];
  results.push(
    await healthResult(fetchImpl, webOrigin, "web"),
    await healthResult(fetchImpl, apiOrigin, "api"),
    await healthResult(fetchImpl, jobsOrigin, "jobs"),
  );
  results.push(await authenticationResult(fetchImpl, apiOrigin));
  results.push(await dependencyResult(fetchImpl, apiOrigin));
  return results;
}

export function assertOperatorDemoReady(results) {
  if (results.length !== 5 || results.some((result) => !result.available)) {
    throw new Error("operator_demo_not_ready");
  }
  return results;
}

async function healthResult(fetchImpl, origin, service) {
  const response = await boundedFetch(fetchImpl, new URL("/health", origin));
  const body = await boundedJson(response);
  const available =
    response.status === 200 &&
    body?.contractVersion === 1 &&
    body?.service === service &&
    body?.status === "ok" &&
    (service === "web" || body?.environment === "dev");
  return { available, component: service };
}

async function authenticationResult(fetchImpl, origin) {
  const response = await boundedFetch(
    fetchImpl,
    new URL("/v1/account", origin),
  );
  await response.body?.cancel();
  return { available: response.status === 401, component: "staff-auth" };
}

async function dependencyResult(fetchImpl, origin) {
  const response = await boundedFetch(
    fetchImpl,
    new URL("/v1/demo/preflight", origin),
  );
  const body = await boundedJson(response);
  const dependencies = Array.isArray(body?.dependencies)
    ? body.dependencies
    : [];
  const names = dependencies.map((dependency) => dependency?.name).sort();
  const available =
    response.status === 200 &&
    body?.contractVersion === "connected-demo-preflight-v1" &&
    body?.status === "ready" &&
    body?.boundary?.destinationClass === "staff-controlled-test" &&
    body?.boundary?.learnerClass === "staff-controlled" &&
    body?.boundary?.sourceClass === "human-approved-rights-cleared" &&
    JSON.stringify(names) === JSON.stringify(REQUIRED_DEPENDENCIES) &&
    dependencies.every(
      (dependency) =>
        dependency?.code === "available" &&
        typeof dependency?.contractVersion === "string" &&
        dependency.contractVersion.length > 0 &&
        dependency.contractVersion.length <= 160,
    );
  return { available, component: "connected-dependencies" };
}

async function boundedFetch(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedJson(response) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("operator_readiness_response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("operator_readiness_response_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readGeneratedOrigins() {
  const source = await readFile(
    path.join(root, ".reflo", "local-stack", "app.env"),
    "utf8",
  );
  const values = Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => {
        const match = /^([A-Z0-9_]+)=([^\r\n]+)$/.exec(line);
        if (match === null) throw new Error("local_stack_environment_invalid");
        return [match[1], match[2]];
      }),
  );
  return {
    apiOrigin: requiredOrigin(values, "REFLO_LOCAL_API_ORIGIN"),
    jobsOrigin: requiredOrigin(values, "REFLO_LOCAL_JOBS_ORIGIN"),
    webOrigin: requiredOrigin(values, "REFLO_LOCAL_WEB_ORIGIN"),
  };
}

function requiredOrigin(values, name) {
  const value = values[name];
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(`${name}_invalid`);
  }
  return origin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const results = await collectOperatorDemoReadiness(
      await readGeneratedOrigins(),
    );
    for (const result of results) {
      console.info(
        `${result.available ? "AVAILABLE" : "UNAVAILABLE"} ${result.component}`,
      );
    }
    assertOperatorDemoReady(results);
  } catch {
    console.error("UNAVAILABLE operator-demo: bounded readiness failed");
    process.exitCode = 1;
  }
}
