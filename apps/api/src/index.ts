import { readServerEnvironment } from "@reflo/config";

import { createApiServer } from "./server.js";

const environment = readServerEnvironment(process.env, {
  defaultPort: 3001,
  hostVariable: "API_HOST",
  portVariable: "API_PORT",
  service: "api",
});

const server = createApiServer(environment);

server.listen(environment.port, environment.host, () => {
  console.info(
    `Reflo API listening on http://${environment.host}:${environment.port}`,
  );
});

function shutdown(signal: NodeJS.Signals) {
  console.info(`Reflo API received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error("Reflo API shutdown failed", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
