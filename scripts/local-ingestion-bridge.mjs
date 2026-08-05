#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = path.join(root, ".reflo", "local-stack");
const bridgeEnvironmentPath = path.join(stateDirectory, "bridge.env");
const workerProfilePath = path.join(
  root,
  ".reflo",
  "local-workers",
  "profile.env",
);
const entrypoint = path.join(
  root,
  "apps",
  "ingestion-bridge",
  "dist",
  "main.js",
);
const pidPath = path.join(stateDirectory, "ingestion-bridge.pid");
const logPath = path.join(stateDirectory, "ingestion-bridge.log");

switch (process.argv[2]) {
  case "start":
    await start();
    break;
  case "status":
    await status();
    break;
  case "stop":
    await stop();
    break;
  case "logs":
    await logs();
    break;
  default:
    console.error(
      "Usage: scripts/local-ingestion-bridge.mjs <start|status|stop|logs>",
    );
    process.exitCode = 2;
}

async function start() {
  await requirePrivateFile(bridgeEnvironmentPath);
  await requirePrivateFile(workerProfilePath);
  const existing = await readPid();
  if (existing !== null) {
    if (isRunning(existing)) {
      requireOwnedProcess(existing);
      console.info("Local ingestion bridge is already running");
      return;
    }
    await rm(pidPath, { force: true });
  }
  const entrypointMetadata = await stat(entrypoint);
  if (!entrypointMetadata.isFile()) {
    throw new Error("build @reflo/ingestion-bridge before starting it");
  }
  const environment = {
    ...parseEnvironment(await readFile(workerProfilePath, "utf8")),
    ...parseEnvironment(await readFile(bridgeEnvironmentPath, "utf8")),
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "production",
    PATH: process.env.PATH,
    REFLO_ENV: "dev",
    TMPDIR: process.env.TMPDIR,
  };
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  const logDescriptor = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entrypoint], {
      cwd: root,
      detached: true,
      env: withoutUndefined(environment),
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
  } finally {
    closeSync(logDescriptor);
  }
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
  await chmod(pidPath, 0o600);
  await delay(500);
  if (!isRunning(child.pid)) {
    await rm(pidPath, { force: true });
    throw new Error("the local ingestion bridge did not stay running");
  }
  console.info("Started the local ingestion bridge");
}

async function status() {
  const pid = await readPid();
  if (pid === null || !isRunning(pid)) {
    console.info("UNAVAILABLE local-ingestion-bridge");
    process.exitCode = 1;
    return;
  }
  requireOwnedProcess(pid);
  console.info("AVAILABLE local-ingestion-bridge");
}

async function stop() {
  const pid = await readPid();
  if (pid === null) {
    console.info("Local ingestion bridge is already stopped");
    return;
  }
  if (!isRunning(pid)) {
    await rm(pidPath, { force: true });
    console.info("Local ingestion bridge is already stopped");
    return;
  }
  requireOwnedProcess(pid);
  process.kill(-pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && isRunning(pid); attempt += 1) {
    await delay(100);
  }
  if (isRunning(pid)) {
    throw new Error("the local ingestion bridge did not stop cleanly");
  }
  await rm(pidPath, { force: true });
  console.info("Stopped the local ingestion bridge");
}

async function logs() {
  const source = await readFile(logPath, "utf8").catch(() => "");
  console.info(source.split(/\r?\n/).slice(-101, -1).join("\n"));
}

async function readPid() {
  const value = await readFile(pidPath, "utf8").catch(() => "");
  if (value === "") return null;
  if (!/^[1-9][0-9]*\n$/.test(value)) {
    throw new Error("the local ingestion bridge PID file is invalid");
  }
  return Number(value.trim());
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function requireOwnedProcess(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024,
  });
  const command = result.status === 0 ? result.stdout.trim() : "";
  if (!command.includes(process.execPath) || !command.includes(entrypoint)) {
    throw new Error(
      "refusing to signal a process not owned by the local bridge",
    );
  }
}

async function requirePrivateFile(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("local bridge configuration must be mode 0600");
  }
}

function parseEnvironment(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) values[match[1]] = unquote(match[2]);
  }
  return values;
}

function withoutUndefined(values) {
  return Object.fromEntries(
    Object.entries(values).filter((entry) => entry[1] !== undefined),
  );
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
