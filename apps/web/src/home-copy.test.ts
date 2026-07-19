import { describe, expect, it } from "vitest";

import { getHomeCopy } from "./home-copy";

describe("getHomeCopy", () => {
  it("includes the product name in the scaffold label", () => {
    expect(getHomeCopy("Reflo").eyebrow).toBe("Reflo learning system");
  });
});
