#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(root, ".reflo", "local-stack", "runtime.env");
const apiUrl = new URL("http://127.0.0.1:53001/v1/dev/auth-inbox/latest");
const appOrigin = "http://127.0.0.1:53000";
const handoffHost = "127.0.0.1";
const handoffPort = 53100;

const metadata = await stat(runtimePath);
if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
  throw new Error("the ignored local runtime configuration must be mode 0600");
}

const values = parseEnvironment(await readFile(runtimePath, "utf8"));
const accessKey = values.get("REFLO_DEV_AUTH_INBOX_ACCESS_KEY");
if (accessKey === undefined || accessKey === "") {
  throw new Error("local authentication is not configured");
}

const response = await fetch(apiUrl, {
  headers: { "x-reflo-dev-inbox-key": accessKey },
  redirect: "error",
  signal: AbortSignal.timeout(6_000),
});
const body = await response.json().catch(() => null);
const rawLoginUrl = body?.message?.loginUrl;
if (!response.ok || typeof rawLoginUrl !== "string") {
  throw new Error("the one-time local sign-in link is unavailable");
}

const loginUrl = assertedLoginUrl(rawLoginUrl);
let delivered = false;
const server = createServer((request, response) => {
  if (delivered || request.method !== "GET" || request.url !== "/") {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return;
  }
  delivered = true;
  response.writeHead(302, {
    "cache-control": "no-store",
    location: loginUrl.toString(),
  });
  response.end();
  server.close();
});

const timeout = setTimeout(() => server.close(), 60_000);
timeout.unref();
server.on("close", () => {
  clearTimeout(timeout);
  if (!delivered) process.exitCode = 1;
});
server.on("error", () => {
  throw new Error("the local sign-in handoff could not start");
});
server.listen(handoffPort, handoffHost, () => {
  console.info("Local sign-in handoff ready");
});

function assertedLoginUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== appOrigin ||
    url.pathname !== "/auth/callback" ||
    url.searchParams.get("token") === null ||
    [...url.searchParams.keys()].some((key) => key !== "token")
  ) {
    throw new Error("the local authentication service returned an unsafe URL");
  }
  return url;
}

function parseEnvironment(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) values.set(match[1], unquote(match[2]));
  }
  return values;
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
