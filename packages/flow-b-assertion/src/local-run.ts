#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runFlowBBrowserAssertion } from "./browser-runner.js";
import { readFlowBAssertionConfig } from "./contracts.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputArgument = process.argv[2];
if (outputArgument === undefined || process.argv.length !== 3) {
  throw new Error(
    "Usage: reflo-flow-b-local-run <new-sanitized-run-record.json>",
  );
}

const outputPath = path.isAbsolute(outputArgument)
  ? outputArgument
  : path.resolve(repositoryRoot, outputArgument);
const temporary = await mkdtemp(path.join(os.tmpdir(), "reflo-flow-b-local-"));
const certificatePath = path.join(temporary, "localhost.crt");
const keyPath = path.join(temporary, "localhost.key");
const children: ManagedProcess[] = [];
const runId = `demo-${randomBytes(16).toString("hex")}`;
const staffEmail = "flow-b-staff@example.test";
const browserExecutable = required("REFLO_FLOW_B_BROWSER_EXECUTABLE");
const baseDatabaseUrl = required("DATABASE_URL");
const flowBDatabaseUrl = new URL(baseDatabaseUrl);
flowBDatabaseUrl.pathname = "/reflo_flow_b_164";
const artifactRoot = path.join(
  repositoryRoot,
  ".reflo/flow-b-assertion/artifacts",
);
const runtime = {
  ...process.env,
  API_HOST: "127.0.0.1",
  API_PORT: "3001",
  DATABASE_URL: flowBDatabaseUrl.toString(),
  NEXT_PUBLIC_REFLO_API_ORIGIN: "https://localhost:3444",
  NEXT_PUBLIC_REFLO_ENV: "dev",
  REFLO_AUTH_CALLBACK_ORIGINS: "https://localhost:3443",
  REFLO_AUTH_EMAIL_ADAPTER: "local-inbox",
  REFLO_AUTH_EMAIL_ENCRYPTION_KEY: key("auth-email-encryption"),
  REFLO_AUTH_LOOKUP_KEY: key("auth-lookup"),
  REFLO_AUTH_SESSION_DIGEST_KEY: key("auth-session"),
  REFLO_AUTH_TOKEN_DIGEST_KEY: key("auth-token"),
  REFLO_CONNECTED_DEMO_ARTIFACT_ROOT: artifactRoot,
  REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
  REFLO_DEMO_DELIVERY_MODE: "staff-only-demo-v1",
  REFLO_DEMO_DESTINATION_LOOKUP_KEY: key("delivery-destination"),
  REFLO_DEMO_FIXED_NOW: "2030-07-25T09:00:00.000Z",
  REFLO_DEMO_EMAIL_CHANNEL_ID: "16400000-0000-4000-8000-000000000020",
  REFLO_DEMO_EMAIL_DESTINATION: staffEmail,
  REFLO_DEMO_EMAIL_LINK_ORIGIN: "https://localhost:3443",
  REFLO_DEMO_EMAIL_LINK_SIGNING_KEY: key("delivery-email-link"),
  REFLO_DEMO_EMAIL_OWNER_SCOPE_ID: "16400000-0000-4000-8000-00000000000a",
  REFLO_DEMO_EMAIL_USER_ID: "16400000-0000-4000-8000-000000000001",
  REFLO_DEMO_GRADING_CALIBRATION_EVIDENCE_ID:
    "synthetic-demo-calibration-fixture-v1",
  REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD: "0.95000",
  REFLO_DEMO_REVIEW_LOCAL_TIME: "09:00",
  REFLO_DEMO_REVIEW_TIME_ZONE: "UTC",
  REFLO_DEMO_SEED_COURSE_ID: "16400000-0000-4000-8000-000000000005",
  REFLO_DEMO_TELEGRAM_BOT_TOKEN: `164:${"a".repeat(32)}`,
  REFLO_DEMO_TELEGRAM_CHANNEL_ID: "16400000-0000-4000-8000-000000000021",
  REFLO_DEMO_TELEGRAM_DESTINATION: "100164000",
  REFLO_DEMO_TELEGRAM_OWNER_SCOPE_ID: "16400000-0000-4000-8000-00000000000a",
  REFLO_DEMO_TELEGRAM_USER_ID: "16400000-0000-4000-8000-000000000001",
  REFLO_DEMO_TELEGRAM_WEBHOOK_SECRET: "flow-b-local-webhook-secret-164-test",
  REFLO_DEMO_MESSAGE_ADAPTER: "local-fixture",
  REFLO_DEMO_TRACE_RUN_ID: runId,
  REFLO_DEMO_TRACING_MODE: "staff-only-demo-v1",
  REFLO_DEV_AUTH_INBOX_ACCESS_KEY: "flow-b-local-inbox-access-key-164",
  REFLO_DEV_AUTH_INBOX_DESTINATION: staffEmail,
  REFLO_DIRECTMAIL_DAILY_LIMIT: "200",
  REFLO_DIRECTMAIL_ELIGIBILITY: "approved-free-quota-v1",
  REFLO_DIRECTMAIL_FROM_ALIAS: "Reflo",
  REFLO_DIRECTMAIL_RAM_ROLE_NAME: "reflo-directmail-runtime",
  REFLO_DIRECTMAIL_REGION: "ap-southeast-1",
  REFLO_DIRECTMAIL_SENDER_ADDRESS: "demo@reflo.example",
  REFLO_DIRECTMAIL_TOTAL_LIMIT: "2000",
  REFLO_ENV: "dev",
  REFLO_FLOW_B_API_BASE_URL: "http://127.0.0.1:3001",
  REFLO_FLOW_B_APP_BASE_URL: "https://localhost:3443",
  REFLO_FLOW_B_AUTH_INBOX_ACCESS_KEY: "flow-b-local-inbox-access-key-164",
  REFLO_FLOW_B_AUTH_MODE: "local-inbox",
  REFLO_FLOW_B_BROWSER_API_BASE_URL: "https://localhost:3444",
  REFLO_FLOW_B_BROWSER_EXECUTABLE: browserExecutable,
  REFLO_FLOW_B_BASE_DATABASE_URL: baseDatabaseUrl,
  REFLO_FLOW_B_INITIAL_RESPONSE:
    "This synthetic response incorrectly describes a public bucket.",
  REFLO_FLOW_B_MODEL_FIXTURE_PORT: "4001",
  REFLO_FLOW_B_MODE: "development-connected",
  REFLO_FLOW_B_RETEST_RESPONSE:
    "Retention is strengthened by correct evidence from a distinct isolated check; lesson exposure alone is not evidence.",
  REFLO_FLOW_B_RUN_ID: runId,
  REFLO_FLOW_B_STAFF_EMAIL: staffEmail,
  REFLO_FLOW_B_TELEGRAM_DESTINATION: "100164000",
  REFLO_FLOW_B_TELEGRAM_WEBHOOK_SECRET: "flow-b-local-webhook-secret-164-test",
  REFLO_FLOW_B_TIMEOUT_MS: "15000",
  REFLO_FLOW_B_TRACE_PROBE_URL: "http://127.0.0.1:4001/__reflo/traces/",
  REFLO_LANGFUSE_BASE_URL: "http://127.0.0.1:4001/",
  REFLO_LANGFUSE_PUBLIC_KEY: "flow-b-local-public",
  REFLO_LANGFUSE_SECRET_KEY: "flow-b-local-secret",
  REFLO_LITELLM_API_KEY: "flow-b-local-model-key",
  REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4001",
  REFLO_LITELLM_EMBEDDING_MODEL: "fireworks_ai/thenlper/gte-large",
  REFLO_LITELLM_TEXT_MODEL: "reflo-local-text",
  REFLO_MODEL_ADAPTER: "litellm-dev",
  REFLO_SLS_ACCESS_KEY_ID: "flow-b-local-access",
  REFLO_SLS_ACCESS_KEY_SECRET: "flow-b-local-secret",
  REFLO_SLS_OTEL_ENDPOINT: "http://127.0.0.1:4001/opentelemetry/v1/traces",
  REFLO_SLS_PROJECT: "flow_b_local",
  REFLO_SLS_TRACE_INSTANCE_ID: "flow_b_local",
};

try {
  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { cwd: repositoryRoot },
  );
  await execFileAsync(
    "corepack",
    ["pnpm", "--filter", "@reflo/api...", "build"],
    {
      cwd: repositoryRoot,
      env: runtime,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await execFileAsync("corepack", ["pnpm", "--filter", "@reflo/web", "build"], {
    cwd: repositoryRoot,
    env: runtime,
    maxBuffer: 4 * 1024 * 1024,
  });
  await execFileAsync(
    "corepack",
    ["pnpm", "--filter", "@reflo/db", "flow-b:database"],
    {
      cwd: repositoryRoot,
      env: runtime,
      maxBuffer: 1024 * 1024,
    },
  );
  await execFileAsync(
    "corepack",
    ["pnpm", "--filter", "@reflo/db", "db:migrate"],
    {
      cwd: repositoryRoot,
      env: runtime,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await execFileAsync(
    "corepack",
    ["pnpm", "--filter", "@reflo/db", "flow-b:development-profile"],
    {
      cwd: repositoryRoot,
      env: runtime,
      maxBuffer: 1024 * 1024,
    },
  );
  children.push(
    start("model", process.execPath, [
      path.join(
        repositoryRoot,
        "packages/flow-b-assertion/dist/local-model-fixture.js",
      ),
    ]),
  );
  await waitForPort(4_001, children, 15_000);
  await execFileAsync(
    "corepack",
    ["pnpm", "--filter", "@reflo/db", "flow-b:prepare"],
    {
      cwd: repositoryRoot,
      env: runtime,
      maxBuffer: 1024 * 1024,
    },
  );
  children.push(
    start("api", "corepack", ["pnpm", "--filter", "@reflo/api", "start"]),
    start(
      "web",
      process.execPath,
      [
        path.join(
          repositoryRoot,
          "packages/flow-b-assertion/dist/local-static-server.js",
        ),
      ],
      {
        REFLO_FLOW_B_STATIC_PORT: "3000",
        REFLO_FLOW_B_STATIC_ROOT: path.join(repositoryRoot, "apps/web/out"),
      },
    ),
  );
  await Promise.all([
    waitForPort(3_001, children, 45_000),
    waitForPort(3_000, children, 45_000),
  ]);
  children.push(
    start(
      "web-tls",
      process.execPath,
      [
        path.join(
          repositoryRoot,
          "packages/flow-b-assertion/dist/local-tls-proxy.js",
        ),
      ],
      {
        REFLO_FLOW_B_TLS_CERT_PATH: certificatePath,
        REFLO_FLOW_B_TLS_KEY_PATH: keyPath,
        REFLO_FLOW_B_TLS_PORT: "3443",
        REFLO_FLOW_B_TLS_TARGET: "http://127.0.0.1:3000",
      },
    ),
    start(
      "api-tls",
      process.execPath,
      [
        path.join(
          repositoryRoot,
          "packages/flow-b-assertion/dist/local-tls-proxy.js",
        ),
      ],
      {
        REFLO_FLOW_B_TLS_CERT_PATH: certificatePath,
        REFLO_FLOW_B_TLS_KEY_PATH: keyPath,
        REFLO_FLOW_B_TLS_PORT: "3444",
        REFLO_FLOW_B_TLS_TARGET: "http://127.0.0.1:3001",
      },
    ),
  );
  await Promise.all([
    waitForPort(3_443, children, 15_000),
    waitForPort(3_444, children, 15_000),
  ]);

  const record = await runFlowBBrowserAssertion(
    readFlowBAssertionConfig(runtime),
  );
  await mkdir(path.dirname(outputPath), { mode: 0o700, recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.info(
    `${record.assertionVersion}: passed record=${record.recordDigest}`,
  );
} catch (error) {
  const tails = children
    .map((child) => child.failureContext())
    .filter((value) => value !== "")
    .join("\n");
  if (tails !== "") {
    console.error(tails);
  }
  throw error;
} finally {
  await Promise.all(children.reverse().map((child) => child.stop()));
  await rm(temporary, { force: true, recursive: true });
}

interface ManagedProcess {
  readonly child: ChildProcess;
  failureContext(): string;
  stop(): Promise<void>;
}

function start(
  name: string,
  command: string,
  args: readonly string[],
  additions: Readonly<Record<string, string>> = {},
): ManagedProcess {
  const child = spawn(command, [...args], {
    cwd: repositoryRoot,
    env: { ...runtime, ...additions },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const append = (chunk: Buffer): void => {
    tail = `${tail}${chunk.toString("utf8")}`.slice(-4_096);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    child,
    failureContext: () =>
      tail.trim() === ""
        ? ""
        : `${name}${child.exitCode === null ? "" : " exited"}:\n${tail.trim()}`,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

async function waitForPort(
  port: number,
  processes: readonly ManagedProcess[],
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const failed = processes.find((process) => process.child.exitCode !== null);
    if (failed !== undefined) {
      throw new Error("local connected service exited before readiness");
    }
    if (await portReady(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`local connected service timed out on port ${port}`);
}

function portReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function key(label: string): string {
  return createHash("sha256")
    .update(`reflo-flow-b-local/${label}`)
    .digest("base64");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
