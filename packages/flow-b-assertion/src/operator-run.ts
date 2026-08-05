#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runFlowBBrowserAssertion } from "./browser-runner.js";
import { readFlowBAssertionConfig } from "./contracts.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputArgument = process.argv[2];
if (outputArgument === undefined || process.argv.length !== 3) {
  throw new Error(
    "Usage: reflo-flow-b-operator-run <new-sanitized-run-record.json>",
  );
}

const localStackRoot = path.join(repositoryRoot, ".reflo", "local-stack");
const [appEnvironment, privateRuntimeEnvironment] = await Promise.all([
  readEnvironmentFile(path.join(localStackRoot, "app.env")),
  readEnvironmentFile(path.join(localStackRoot, "runtime.env")),
]);
const runtime: NodeJS.ProcessEnv = {
  ...appEnvironment,
  ...privateRuntimeEnvironment,
  ...process.env,
  REFLO_FLOW_B_API_BASE_URL:
    process.env.REFLO_FLOW_B_API_BASE_URL ??
    privateRuntimeEnvironment.REFLO_FLOW_B_API_BASE_URL ??
    required(appEnvironment, "REFLO_LOCAL_API_ORIGIN"),
  REFLO_FLOW_B_APP_BASE_URL:
    process.env.REFLO_FLOW_B_APP_BASE_URL ??
    privateRuntimeEnvironment.REFLO_FLOW_B_APP_BASE_URL ??
    required(appEnvironment, "REFLO_LOCAL_WEB_ORIGIN"),
  REFLO_FLOW_B_BROWSER_API_BASE_URL:
    process.env.REFLO_FLOW_B_BROWSER_API_BASE_URL ??
    privateRuntimeEnvironment.REFLO_FLOW_B_BROWSER_API_BASE_URL ??
    required(appEnvironment, "REFLO_LOCAL_API_ORIGIN"),
  REFLO_FLOW_B_MODE: "development-connected",
  REFLO_FLOW_B_RUN_ID: `demo-${randomBytes(16).toString("hex")}`,
  REFLO_FLOW_B_TARGET_PROFILE: "operator-hosted-connected-demo-v1",
};
const record = await runFlowBBrowserAssertion(
  readFlowBAssertionConfig(runtime),
);
const outputPath = path.resolve(repositoryRoot, outputArgument);
await mkdir(path.dirname(outputPath), { mode: 0o700, recursive: true });
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
console.info(
  [
    `${record.assertionVersion}: passed`,
    `durationMs=${record.durationMs}`,
    `target=${record.targetProfile}`,
    `run=${record.runId}`,
    `record=${record.recordDigest}`,
  ].join(" "),
);

async function readEnvironmentFile(
  filename: string,
): Promise<Record<string, string>> {
  const source = await readFile(filename, "utf8");
  const environment: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      throw new Error(`local runtime environment line ${index + 1} is invalid`);
    }
    const key = match[1]!;
    const rawValue = match[2]!;
    const value = unquote(rawValue);
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`local runtime environment value ${key} is invalid`);
    }
    environment[key] = value;
  }
  return environment;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function required(
  input: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required in the generated local stack`);
  }
  return value;
}
