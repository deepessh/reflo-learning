import { describe, expect, it } from "vitest";

import { MODEL_TASK_IDS } from "./contracts.js";
import { ROUTE_POLICY_V2 } from "./policy.js";
import { PROMPT_REGISTRY_V1 } from "./prompts.js";

describe("route-policy-v2", () => {
  it("contains every semantic task exactly once", () => {
    expect(Object.keys(ROUTE_POLICY_V2).sort()).toEqual(
      [...MODEL_TASK_IDS].sort(),
    );
    for (const task of MODEL_TASK_IDS) {
      expect(ROUTE_POLICY_V2[task].task).toBe(task);
      expect(ROUTE_POLICY_V2[task].fallback).toBe(
        task === "media.tts.v1" ? "piper-tts.cpu" : null,
      );
    }
  });

  it("binds every prompted route to its immutable registry entry", () => {
    for (const definition of Object.values(PROMPT_REGISTRY_V1)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.fixedInstructions)).toBe(true);
      expect(definition.fixedInstructions.join(" ")).toContain(
        "untrusted data",
      );
    }
  });

  it("caps attempts and requires proven submission idempotency for media retries", () => {
    for (const route of Object.values(ROUTE_POLICY_V2)) {
      if (route.capability === "speech" || route.capability === "video") {
        expect(
          "mediaRetryRequiresSubmissionIdempotency" in route &&
            route.mediaRetryRequiresSubmissionIdempotency,
        ).toBe(true);
        expect(route.maxImmediateAttempts).toBeLessThanOrEqual(2);
      } else {
        expect(route.maxImmediateAttempts).toBeLessThanOrEqual(2);
      }
    }
  });
});
