import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";

import { readServerEnvironment, type Deployment } from "@reflo/config";

import { createAccountRuntime } from "./account-composition.js";
import { createConnectedDemoRuntime } from "./connected-composition.js";
import { createDeliveryRuntime } from "./delivery-composition.js";
import { createDemoUploadRuntime } from "./demo-upload-composition.js";
import { createApiRequestListener, createApiServer } from "./server.js";

const environment = readServerEnvironment(process.env, {
  defaultPort: 3001,
  hostVariable: "API_HOST",
  portVariable: "API_PORT",
  service: "api",
});

const accountRuntime = createAccountRuntime(
  process.env,
  environment.deployment,
);
const deliveryRuntime = createDeliveryRuntime(
  process.env,
  environment.deployment,
);
const connectedRuntime = await createConnectedDemoRuntime(
  process.env,
  environment.deployment,
);
const demoUploadRuntime = await createDemoUploadRuntime(
  process.env,
  environment.deployment,
);
const now = demoClock(process.env, environment.deployment);
const dependencies = {
  accounts: accountRuntime.accounts,
  assessment: connectedRuntime.assessment,
  delivery: deliveryRuntime.delivery,
  demoUploads: demoUploadRuntime.demoUploads,
  localAuthInbox: accountRuntime.localInbox,
  now,
  preflight: connectedRuntime.preflight,
  seed: connectedRuntime.seed,
  sessions: connectedRuntime.sessions,
  study: connectedRuntime.study,
  tutorAgent: connectedRuntime.tutorAgent,
};
const tls = apiTlsConfiguration(process.env);
const server =
  tls === null
    ? createApiServer(environment, dependencies)
    : createHttpsServer(
        tls,
        createApiRequestListener(environment, dependencies),
      );

server.listen(environment.port, environment.host, () => {
  console.info(
    `Reflo API listening on ${tls === null ? "http" : "https"}://${environment.host}:${environment.port}`,
  );
});

function shutdown(signal: NodeJS.Signals) {
  console.info(`Reflo API received ${signal}; shutting down`);
  server.close(async (error) => {
    const cleanup = await Promise.allSettled([
      accountRuntime.close(),
      connectedRuntime.close(),
      deliveryRuntime.close(),
      demoUploadRuntime.close(),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      process.exitCode = 1;
    }
    if (error) {
      console.error("Reflo API shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function apiTlsConfiguration(
  input: NodeJS.ProcessEnv,
): { readonly cert: Buffer; readonly key: Buffer } | null {
  const certificatePath = input.REFLO_API_TLS_CERTIFICATE_FILE?.trim();
  const privateKeyPath = input.REFLO_API_TLS_PRIVATE_KEY_FILE?.trim();
  if (certificatePath === undefined && privateKeyPath === undefined) {
    return null;
  }
  if (
    certificatePath === undefined ||
    certificatePath === "" ||
    privateKeyPath === undefined ||
    privateKeyPath === ""
  ) {
    throw new Error("API TLS certificate configuration is incomplete");
  }
  return {
    cert: readFileSync(certificatePath),
    key: readFileSync(privateKeyPath),
  };
}

function demoClock(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): (() => Date) | undefined {
  const fixed = input.REFLO_DEMO_FIXED_NOW?.trim();
  if (fixed === undefined || fixed === "") {
    return undefined;
  }
  if (
    deployment !== "dev" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fixed) ||
    new Date(fixed).toISOString() !== fixed
  ) {
    throw new Error("REFLO_DEMO_FIXED_NOW is invalid");
  }
  return () => new Date(fixed);
}
