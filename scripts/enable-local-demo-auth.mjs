#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(root, ".reflo", "local-stack", "runtime.env");
const temporaryPath = path.join(
  path.dirname(runtimePath),
  ".runtime.env.auth-next",
);
const syntheticStaffDestination = "reflo-demo-staff@example.test";

const metadata = await stat(runtimePath);
if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
  throw new Error("the ignored local runtime configuration must be mode 0600");
}

const source = await readFile(runtimePath, "utf8");
const lines = source.split(/\r?\n/);
const values = new Map();
for (const line of lines) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (match !== null) values.set(match[1], unquote(match[2]));
}

const adapter = values.get("REFLO_AUTH_EMAIL_ADAPTER");
if (
  adapter !== undefined &&
  adapter !== "" &&
  adapter !== "disabled" &&
  adapter !== "local-inbox"
) {
  throw new Error("refusing to replace a configured non-local auth adapter");
}
const destination = values.get("REFLO_DEV_AUTH_INBOX_DESTINATION");
if (
  destination !== undefined &&
  destination !== "" &&
  destination !== syntheticStaffDestination
) {
  throw new Error("refusing to replace a configured local inbox destination");
}

const updates = new Map([
  ["REFLO_AUTH_EMAIL_ADAPTER", "local-inbox"],
  ["REFLO_DEV_AUTH_INBOX_DESTINATION", syntheticStaffDestination],
  [
    "REFLO_DEV_AUTH_INBOX_ACCESS_KEY",
    existingOrRandom(values, "REFLO_DEV_AUTH_INBOX_ACCESS_KEY", "hex"),
  ],
  [
    "REFLO_AUTH_EMAIL_ENCRYPTION_KEY",
    existingOrRandom(values, "REFLO_AUTH_EMAIL_ENCRYPTION_KEY", "base64"),
  ],
  [
    "REFLO_AUTH_LOOKUP_KEY",
    existingOrRandom(values, "REFLO_AUTH_LOOKUP_KEY", "base64"),
  ],
  [
    "REFLO_AUTH_SESSION_DIGEST_KEY",
    existingOrRandom(values, "REFLO_AUTH_SESSION_DIGEST_KEY", "base64"),
  ],
  [
    "REFLO_AUTH_TOKEN_DIGEST_KEY",
    existingOrRandom(values, "REFLO_AUTH_TOKEN_DIGEST_KEY", "base64"),
  ],
]);

const seen = new Set();
const nextLines = lines.map((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
  const key = match?.[1];
  if (key === undefined || !updates.has(key)) return line;
  seen.add(key);
  return `${key}=${updates.get(key)}`;
});
for (const [key, value] of updates) {
  if (!seen.has(key)) nextLines.push(`${key}=${value}`);
}
const rendered = `${nextLines
  .filter((line, index) => index < nextLines.length - 1 || line !== "")
  .join("\n")}\n`;
await writeFile(temporaryPath, rendered, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, runtimePath);
await chmod(runtimePath, 0o600);
console.info("Configured the synthetic local staff authentication boundary");

function existingOrRandom(values, key, encoding) {
  const existing = values.get(key);
  if (existing !== undefined && existing !== "") return existing;
  return randomBytes(32).toString(encoding);
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
