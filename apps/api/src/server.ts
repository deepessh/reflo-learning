import { createServer, type Server } from "node:http";

import type { ServerEnvironment } from "@reflo/config";
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from "@reflo/contracts";

export function createApiServer(environment: ServerEnvironment): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body: HealthResponse = {
        contractVersion: HEALTH_CONTRACT_VERSION,
        environment: environment.deployment,
        service: environment.service,
        status: "ok",
      };

      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
