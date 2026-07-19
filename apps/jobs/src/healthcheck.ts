import { readServerEnvironment } from "@reflo/config";
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from "@reflo/contracts";

export function healthcheck(
  environmentInput: NodeJS.ProcessEnv = process.env,
): HealthResponse {
  const environment = readServerEnvironment(environmentInput, {
    defaultPort: 3002,
    service: "jobs",
  });

  return {
    contractVersion: HEALTH_CONTRACT_VERSION,
    environment: environment.deployment,
    service: environment.service,
    status: "ok",
  };
}
