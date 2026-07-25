import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { readServerEnvironment, type ServerEnvironment } from "@reflo/config";
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from "@reflo/contracts";

import {
  developmentJobFailureMessage,
  runDevelopmentJob,
  type DevelopmentJobDependencies,
  type DevelopmentJobExecution,
} from "./development-runner.js";

export function createJobsReadinessServer(
  environment: ServerEnvironment,
): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const body: HealthResponse = {
      contractVersion: HEALTH_CONTRACT_VERSION,
      environment: environment.deployment,
      service: environment.service,
      status: "ok",
    };
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  });
}

export async function prepareJobsContainer(
  input: NodeJS.ProcessEnv = process.env,
  dependencies: DevelopmentJobDependencies = {},
): Promise<{
  readonly environment: ServerEnvironment;
  readonly execution: DevelopmentJobExecution;
}> {
  const execution = await runDevelopmentJob(input, dependencies);
  const environment = readServerEnvironment(input, {
    defaultPort: 3002,
    hostVariable: "JOBS_HOST",
    portVariable: "JOBS_PORT",
    service: "jobs",
  });
  return { environment, execution };
}

async function start(): Promise<void> {
  const prepared = await prepareJobsContainer();
  const { environment } = prepared;
  const server = createJobsReadinessServer(environment);
  let stopping = false;

  server.listen(environment.port, environment.host, () => {
    console.info(
      `Reflo jobs ready on http://${environment.host}:${environment.port}`,
      prepared.execution,
    );
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`Reflo jobs received ${signal}; shutting down`);
    server.close((error) => {
      if (error) {
        console.error("Reflo jobs shutdown failed");
        process.exitCode = 1;
      }
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await start().catch((error) => {
    console.error(developmentJobFailureMessage(error));
    process.exitCode = 1;
  });
}
