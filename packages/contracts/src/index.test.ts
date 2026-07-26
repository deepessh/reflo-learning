import { describe, expect, it } from "vitest";

import {
  CONNECTED_DEMO_BOUNDARY_VERSION,
  CONNECTED_DEMO_PREFLIGHT_VERSION,
  CONNECTED_STUDY_VIEW_VERSION,
  DEMO_UPLOAD_CONTRACT_VERSION,
  HEALTH_CONTRACT_VERSION,
} from "./index";

describe("health contract", () => {
  it("has a stable initial version", () => {
    expect(HEALTH_CONTRACT_VERSION).toBe(1);
    expect(CONNECTED_DEMO_BOUNDARY_VERSION).toBe("connected-demo-boundary-v1");
    expect(CONNECTED_DEMO_PREFLIGHT_VERSION).toBe(
      "connected-demo-preflight-v1",
    );
    expect(CONNECTED_STUDY_VIEW_VERSION).toBe("connected-study-view-v1");
    expect(DEMO_UPLOAD_CONTRACT_VERSION).toBe("demo-upload-v1");
  });
});
