import { readServerEnvironment } from "@reflo/config";

import { createAccountRuntime } from "./account-composition.js";
import { createApiServer } from "./server.js";

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
const server = createApiServer(environment, {
  accounts: accountRuntime.accounts,
});

server.listen(environment.port, environment.host, () => {
  console.info(
    `Reflo API listening on http://${environment.host}:${environment.port}`,
  );
});

function shutdown(signal: NodeJS.Signals) {
  console.info(`Reflo API received ${signal}; shutting down`);
  server.close(async (error) => {
    await accountRuntime.close().catch(() => {
      process.exitCode = 1;
    });
    if (error) {
      console.error("Reflo API shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
