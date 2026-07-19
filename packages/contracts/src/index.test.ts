import { describe, expect, it } from "vitest";

import { HEALTH_CONTRACT_VERSION } from "./index";

describe("health contract", () => {
  it("has a stable initial version", () => {
    expect(HEALTH_CONTRACT_VERSION).toBe(1);
  });
});
