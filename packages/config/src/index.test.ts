import { describe, expect, it } from "vitest";

import { readPublicEnvironment, readServerEnvironment } from "./index";

describe("environment validation", () => {
  it("uses safe local defaults outside production", () => {
    expect(
      readServerEnvironment({}, { defaultPort: 3001, service: "api" }),
    ).toEqual({
      deployment: "dev",
      host: "127.0.0.1",
      port: 3001,
      service: "api",
    });
  });

  it("requires an explicit deployment in production", () => {
    expect(() =>
      readServerEnvironment(
        { NODE_ENV: "production" },
        { defaultPort: 3001, service: "api" },
      ),
    ).toThrow("REFLO_ENV is required");
  });

  it("rejects unknown public deployments", () => {
    expect(() => readPublicEnvironment("production")).toThrow(
      "NEXT_PUBLIC_REFLO_ENV must be one of",
    );
  });

  it("rejects invalid ports", () => {
    expect(() =>
      readServerEnvironment(
        { API_PORT: "70000" },
        { defaultPort: 3001, portVariable: "API_PORT", service: "api" },
      ),
    ).toThrow("API_PORT must be an integer");
  });
});
