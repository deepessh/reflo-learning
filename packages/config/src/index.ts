export const APP_NAME = "Reflo";

export const DEPLOYMENTS = ["dev", "staging", "pilot"] as const;

export type Deployment = (typeof DEPLOYMENTS)[number];

export interface ServerEnvironment {
  readonly deployment: Deployment;
  readonly host: string;
  readonly port: number;
  readonly service: string;
}

interface ServerEnvironmentOptions {
  readonly defaultPort: number;
  readonly hostVariable?: string;
  readonly portVariable?: string;
  readonly service: string;
}

export function readPublicEnvironment(value: string | undefined): Deployment {
  return parseDeployment(value ?? "dev", "NEXT_PUBLIC_REFLO_ENV");
}

export function readServerEnvironment(
  input: NodeJS.ProcessEnv,
  options: ServerEnvironmentOptions,
): ServerEnvironment {
  if (input.NODE_ENV === "production" && input.REFLO_ENV === undefined) {
    throw new Error("REFLO_ENV is required when NODE_ENV=production");
  }

  const deployment = parseDeployment(input.REFLO_ENV ?? "dev", "REFLO_ENV");
  const hostVariable = options.hostVariable ?? "HOST";
  const portVariable = options.portVariable ?? "PORT";
  const host = input[hostVariable] ?? "127.0.0.1";
  const port = parsePort(
    input[portVariable],
    options.defaultPort,
    portVariable,
  );

  return {
    deployment,
    host,
    port,
    service: options.service,
  };
}

function parseDeployment(value: string, variableName: string): Deployment {
  if ((DEPLOYMENTS as readonly string[]).includes(value)) {
    return value as Deployment;
  }

  throw new Error(`${variableName} must be one of: ${DEPLOYMENTS.join(", ")}`);
}

function parsePort(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535`);
  }

  return port;
}
