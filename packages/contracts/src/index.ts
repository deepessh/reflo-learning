export const HEALTH_CONTRACT_VERSION = 1 as const;

export interface HealthResponse {
  readonly contractVersion: typeof HEALTH_CONTRACT_VERSION;
  readonly environment: "dev" | "staging" | "pilot";
  readonly service: string;
  readonly status: "ok";
}
