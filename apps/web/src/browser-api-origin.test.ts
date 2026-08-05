import { describe, expect, it } from "vitest";

import { canonicalPageUrl } from "./browser-api-origin";

describe("browser API origin", () => {
  it("uses the configured loopback host while preserving the page URL", () => {
    expect(
      canonicalPageUrl(
        "http://127.0.0.1:53001",
        "http://localhost:53000/review?token=opaque#question",
      ),
    ).toBe("http://127.0.0.1:53000/review?token=opaque#question");
    expect(
      canonicalPageUrl(
        "http://localhost:53001",
        "http://127.0.0.1:53000/auth/callback?token=opaque",
      ),
    ).toBe("http://localhost:53000/auth/callback?token=opaque");
  });

  it("does not redirect an already canonical loopback page", () => {
    expect(
      canonicalPageUrl("http://127.0.0.1:53001", "http://127.0.0.1:53000/"),
    ).toBeNull();
  });

  it("fails closed for other protocols, hosts, and malformed origins", () => {
    expect(
      canonicalPageUrl("https://127.0.0.1:53001", "http://localhost:53000"),
    ).toBeNull();
    expect(
      canonicalPageUrl("http://127.0.0.1:53001", "http://reflo.example"),
    ).toBeNull();
    expect(
      canonicalPageUrl(
        "http://api.reflo.example:53001",
        "http://localhost:53000",
      ),
    ).toBeNull();
    expect(
      canonicalPageUrl("not-an-origin", "http://localhost:53000"),
    ).toBeNull();
  });
});
