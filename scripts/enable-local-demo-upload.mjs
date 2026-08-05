#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = path.join(root, ".reflo", "local-stack");
const runtimePath = path.join(stateDirectory, "runtime.env");
const composeEnvironmentPath = path.join(stateDirectory, "compose.env");
const applicationEnvironmentPath = path.join(stateDirectory, "app.env");
const bridgeEnvironmentPath = path.join(stateDirectory, "bridge.env");
const workerProfilePath = path.join(
  root,
  ".reflo",
  "local-workers",
  "profile.env",
);
const composePath = path.join(root, "compose.yaml");
const bridgeProfile = "operator-hosted-connected-demo-v1";
const bridgeVersion = "local-isolated-ingestion-bridge-v1";

for (const file of [
  runtimePath,
  composeEnvironmentPath,
  applicationEnvironmentPath,
  workerProfilePath,
]) {
  await requirePrivateFile(file);
}

const runtimeSource = await readFile(runtimePath, "utf8");
const runtime = parseEnvironment(runtimeSource);
const composeSource = await readFile(composeEnvironmentPath, "utf8");
const composeEnvironment = parseEnvironment(composeSource);
const application = parseEnvironment(
  await readFile(applicationEnvironmentPath, "utf8"),
);
const workers = parseEnvironment(await readFile(workerProfilePath, "utf8"));

if (runtime.get("REFLO_AUTH_EMAIL_ADAPTER") !== "local-inbox") {
  throw new Error("local staff authentication must be enabled first");
}
for (const name of [
  "REFLO_LITELLM_API_KEY",
  "REFLO_LITELLM_BASE_URL",
  "REFLO_LITELLM_EMBEDDING_MODEL",
  "REFLO_LITELLM_TEXT_MODEL",
]) {
  required(runtime, name);
}

const modelUrl = new URL(required(runtime, "REFLO_LITELLM_BASE_URL"));
const loopbackModel = new Set(["127.0.0.1", "localhost", "[::1]"]).has(
  modelUrl.hostname,
);
if (modelUrl.protocol !== "https:" && !loopbackModel) {
  throw new Error("the configured model gateway is not safe for local upload");
}
const containerModelUrl = new URL(modelUrl);
if (loopbackModel) containerModelUrl.hostname = "host.docker.internal";

const workerImageDigest = required(
  workers,
  "REFLO_LOCAL_INGESTION_IMAGE_DIGEST",
);
const scannerSnapshotId = required(workers, "REFLO_LOCAL_CLAMAV_SNAPSHOT_ID");
if (!/^sha256:[a-f0-9]{64}$/.test(workerImageDigest)) {
  throw new Error("the prepared ingestion image digest is invalid");
}
if (!/^cvd-[a-f0-9]{32}$/.test(scannerSnapshotId)) {
  throw new Error("the admitted scanner snapshot identity is invalid");
}

const [operatorUserId, operatorOwnerScopeId] = currentOperatorIdentity();
const existingToken = runtime.get("REFLO_LOCAL_INGESTION_BRIDGE_TOKEN");
const bridgeToken =
  existingToken !== undefined && /^[a-f0-9]{64}$/.test(existingToken)
    ? existingToken
    : randomBytes(32).toString("hex");

await replaceEnvironment(
  runtimePath,
  runtimeSource,
  new Map([
    [
      "REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE",
      "staff-controlled-rights-cleared-v1",
    ],
    ["REFLO_CONNECTED_DEMO_MODE", "staff-only-demo-v1"],
    ["REFLO_CONNECTED_DEMO_OBJECT_STORE", "local-filesystem-v1"],
    [
      "REFLO_DEMO_GRADING_CALIBRATION_EVIDENCE_ID",
      "operator-hosted-demo-calibration-v1",
    ],
    ["REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD", "0.95000"],
    ["REFLO_DEMO_OPERATOR_OWNER_SCOPE_ID", operatorOwnerScopeId],
    ["REFLO_DEMO_OPERATOR_USER_ID", operatorUserId],
    ["REFLO_DEMO_REVIEW_LOCAL_TIME", "09:00"],
    ["REFLO_DEMO_REVIEW_TIME_ZONE", "UTC"],
    ["REFLO_DEMO_SEED_COURSE_ID", "21600000-0000-4000-8000-000000000005"],
    ["REFLO_DEMO_UPLOAD_PROCESSOR_MODE", bridgeVersion],
    ["REFLO_LOCAL_INGESTION_BRIDGE_PROFILE", bridgeProfile],
    ["REFLO_LOCAL_CLAMAV_SNAPSHOT_ID", scannerSnapshotId],
    ["REFLO_LOCAL_INGESTION_BRIDGE_TOKEN", bridgeToken],
    ["REFLO_LOCAL_INGESTION_IMAGE_DIGEST", workerImageDigest],
    ["REFLO_MODEL_ADAPTER", "litellm-dev"],
  ]),
);

await replaceEnvironment(
  composeEnvironmentPath,
  composeSource,
  new Map([
    ["REFLO_LOCAL_LITELLM_CONTAINER_BASE_URL", containerModelUrl.toString()],
  ]),
);

const apiOrigin = new URL(required(application, "REFLO_LOCAL_API_ORIGIN"));
if (
  apiOrigin.protocol !== "http:" ||
  apiOrigin.hostname !== "127.0.0.1" ||
  apiOrigin.pathname !== "/" ||
  apiOrigin.search !== "" ||
  apiOrigin.hash !== ""
) {
  throw new Error("the local API origin is invalid");
}
await writePrivateFile(
  bridgeEnvironmentPath,
  [
    "# Generated local ingestion bridge configuration. Never commit it.",
    `REFLO_LOCAL_INGESTION_BRIDGE_API_ORIGIN=${apiOrigin.origin}`,
    `REFLO_LOCAL_INGESTION_BRIDGE_TOKEN=${bridgeToken}`,
    `REFLO_LOCAL_INGESTION_BRIDGE_PROFILE=${bridgeProfile}`,
    `REFLO_LOCAL_INGESTION_BRIDGE_WORKSPACE_ROOT=${path.join(stateDirectory, "ingestion-bridge-work")}`,
    "",
  ].join("\n"),
);

console.info("Configured the approved local PDF upload boundary");

function currentOperatorIdentity() {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      "reflo-local",
      "--env-file",
      composeEnvironmentPath,
      "--file",
      composePath,
      "exec",
      "--no-TTY",
      "rds",
      "psql",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--field-separator=|",
      "--username",
      "reflo",
      "--dbname",
      "reflo",
      "--command",
      "SELECT session.user_id, session.owner_scope_id FROM auth_session AS session JOIN scope_membership AS membership ON membership.user_id = session.user_id AND membership.owner_scope_id = session.owner_scope_id WHERE session.revoked_at IS NULL AND session.idle_expires_at > now() AND session.absolute_expires_at > now() AND membership.revoked_at IS NULL ORDER BY session.authenticated_at DESC LIMIT 1",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error("the current local staff identity could not be resolved");
  }
  const parts = result.stdout.trim().split("|");
  if (parts.length !== 2 || parts.some((value) => !isUuid(value))) {
    throw new Error(
      "sign in to the local staff account before enabling upload",
    );
  }
  return parts;
}

async function requirePrivateFile(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("local configuration must be a private regular file");
  }
}

function required(values, name) {
  const value = values.get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
}

function parseEnvironment(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) values.set(match[1], unquote(match[2]));
  }
  return values;
}

async function replaceEnvironment(file, source, updates) {
  const lines = source.split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    const key = match?.[1];
    if (key === undefined || !updates.has(key)) return line;
    seen.add(key);
    return `${key}=${updates.get(key)}`;
  });
  for (const [key, value] of updates) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  await writePrivateFile(
    file,
    `${next.filter((line, index) => index < next.length - 1 || line !== "").join("\n")}\n`,
  );
}

async function writePrivateFile(file, source) {
  const temporary = `${file}.next`;
  await writeFile(temporary, source, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
