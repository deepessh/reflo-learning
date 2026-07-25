import { describe, expect, it } from "vitest";

import { CONNECTED_STUDY_VIEW_VERSION, HEALTH_CONTRACT_VERSION } from "./index";

describe("health contract", () => {
  it("has a stable initial version", () => {
    expect(HEALTH_CONTRACT_VERSION).toBe(1);
    expect(CONNECTED_STUDY_VIEW_VERSION).toBe("connected-study-view-v1");
  });
});
