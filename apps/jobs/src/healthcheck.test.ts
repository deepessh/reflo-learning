import { describe, expect, it } from "vitest";

import { healthcheck } from "./healthcheck";

describe("Function Compute healthcheck", () => {
  it("returns the shared health contract", () => {
    expect(healthcheck({ NODE_ENV: "test", REFLO_ENV: "staging" })).toEqual({
      contractVersion: 1,
      environment: "staging",
      service: "jobs",
      status: "ok",
    });
  });
});
