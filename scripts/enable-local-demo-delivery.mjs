#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = path.join(root, ".reflo", "local-stack");
const runtimePath = path.join(stateDirectory, "runtime.env");
const composeEnvironmentPath = path.join(stateDirectory, "compose.env");
const composePath = path.join(root, "compose.yaml");
const syntheticDestination = "100216000";
const syntheticEmailDestination = "reflo-demo-staff@example.test";

for (const file of [runtimePath, composeEnvironmentPath]) {
  await requirePrivateFile(file);
}

const runtimeSource = await readFile(runtimePath, "utf8");
const runtime = parseEnvironment(runtimeSource);
const composeEnvironment = parseEnvironment(
  await readFile(composeEnvironmentPath, "utf8"),
);
const webPort = composeEnvironment.get("REFLO_LOCAL_WEB_PORT") ?? "53000";
if (!/^\d{4,5}$/.test(webPort) || Number(webPort) > 65_535) {
  throw new Error("REFLO_LOCAL_WEB_PORT is invalid");
}
const emailLinkOrigin = `http://127.0.0.1:${webPort}`;

if (runtime.get("REFLO_AUTH_EMAIL_ADAPTER") !== "local-inbox") {
  throw new Error("local staff authentication must be enabled first");
}
allowExisting(runtime, "REFLO_DEMO_DELIVERY_MODE", [
  "disabled",
  "staff-only-demo-v1",
]);
allowExisting(runtime, "REFLO_DEMO_MESSAGE_ADAPTER", ["local-fixture"]);
allowExisting(runtime, "REFLO_DEMO_DELIVERY_PROVIDER", ["telegram"]);
allowExisting(runtime, "REFLO_DEMO_TELEGRAM_DESTINATION", [
  syntheticDestination,
]);
allowExisting(runtime, "REFLO_DEMO_EMAIL_DESTINATION", [
  syntheticEmailDestination,
]);
allowExisting(runtime, "REFLO_DEMO_EMAIL_LINK_ORIGIN", [emailLinkOrigin]);

const [operatorUserId, operatorOwnerScopeId] = currentOperatorIdentity();
const updates = new Map([
  ["REFLO_DEMO_DELIVERY_MODE", "staff-only-demo-v1"],
  ["REFLO_DEMO_MESSAGE_ADAPTER", "local-fixture"],
  ["REFLO_DEMO_DELIVERY_PROVIDER", "telegram"],
  ["REFLO_FLOW_B_FIXTURE_PROFILE", "operator-hosted-connected-demo-v1"],
  ["REFLO_FLOW_B_STAFF_EMAIL", syntheticEmailDestination],
  [
    "REFLO_DEMO_DESTINATION_LOOKUP_KEY",
    existingOrRandomKey(runtime, "REFLO_DEMO_DESTINATION_LOOKUP_KEY"),
  ],
  [
    "REFLO_DEMO_TELEGRAM_CHANNEL_ID",
    existingOrRandomUuid(runtime, "REFLO_DEMO_TELEGRAM_CHANNEL_ID"),
  ],
  ["REFLO_DEMO_TELEGRAM_DESTINATION", syntheticDestination],
  ["REFLO_DEMO_TELEGRAM_OWNER_SCOPE_ID", operatorOwnerScopeId],
  ["REFLO_DEMO_TELEGRAM_USER_ID", operatorUserId],
  [
    "REFLO_DEMO_TELEGRAM_WEBHOOK_SECRET",
    existingOrRandomHex(runtime, "REFLO_DEMO_TELEGRAM_WEBHOOK_SECRET"),
  ],
  [
    "REFLO_DEMO_EMAIL_CHANNEL_ID",
    existingOrRandomUuid(runtime, "REFLO_DEMO_EMAIL_CHANNEL_ID"),
  ],
  ["REFLO_DEMO_EMAIL_DESTINATION", syntheticEmailDestination],
  ["REFLO_DEMO_EMAIL_OWNER_SCOPE_ID", operatorOwnerScopeId],
  ["REFLO_DEMO_EMAIL_USER_ID", operatorUserId],
  ["REFLO_DEMO_EMAIL_LINK_ORIGIN", emailLinkOrigin],
  [
    "REFLO_DEMO_EMAIL_LINK_SIGNING_KEY",
    existingOrRandomKey(runtime, "REFLO_DEMO_EMAIL_LINK_SIGNING_KEY"),
  ],
]);

await replaceEnvironment(runtimePath, runtimeSource, updates);
console.info("Configured the synthetic local staff delivery boundary");

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
      "sign in to the local staff account before enabling delivery",
    );
  }
  return parts;
}

function allowExisting(values, name, allowed) {
  const value = values.get(name)?.trim();
  if (value !== undefined && value !== "" && !allowed.includes(value)) {
    throw new Error(`refusing to replace configured ${name}`);
  }
}

function existingOrRandomKey(values, name) {
  const existing = values.get(name)?.trim();
  if (existing !== undefined && existing !== "") {
    const decoded = Buffer.from(existing, "base64");
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(existing) ||
      decoded.length !== 32 ||
      decoded.toString("base64") !== existing
    ) {
      throw new Error(`${name} is not a canonical 32-byte key`);
    }
    return existing;
  }
  return randomBytes(32).toString("base64");
}

function existingOrRandomHex(values, name) {
  const existing = values.get(name)?.trim();
  if (existing !== undefined && existing !== "") {
    if (!/^[a-f0-9]{64}$/.test(existing)) {
      throw new Error(`${name} is not a 32-byte hexadecimal secret`);
    }
    return existing;
  }
  return randomBytes(32).toString("hex");
}

function existingOrRandomUuid(values, name) {
  const existing = values.get(name)?.trim();
  if (existing !== undefined && existing !== "") {
    if (!isUuid(existing)) throw new Error(`${name} is not a UUID`);
    return existing;
  }
  return randomUUID();
}

async function requirePrivateFile(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("local configuration must be a private regular file");
  }
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
  const temporary = `${file}.delivery-next`;
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
