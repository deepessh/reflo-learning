import { describe, expect, it } from "vitest";

import { MODEL_TASK_IDS } from "./contracts.js";
import { ROUTE_POLICY_V3 } from "./policy.js";
import { PROMPT_REGISTRY_V1, type PromptedTaskId } from "./prompts.js";

describe("route-policy-v3", () => {
  it("contains every semantic task exactly once", () => {
    expect(Object.keys(ROUTE_POLICY_V3).sort()).toEqual(
      [...MODEL_TASK_IDS].sort(),
    );
    for (const task of MODEL_TASK_IDS) {
      expect(ROUTE_POLICY_V3[task].task).toBe(task);
      expect(ROUTE_POLICY_V3[task].fallback).toBe(
        task === "media.tts.v1" ? "piper-tts.cpu" : null,
      );
    }
  });

  it("binds every prompted route to its immutable registry entry", () => {
    for (const [task, definition] of Object.entries(PROMPT_REGISTRY_V1)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.fixedInstructions)).toBe(true);
      expect(definition.outputContract).toMatch(
        /^Return exactly this JSON shape with no additional keys:/,
      );
      expect(definition.fixedInstructions.join(" ")).toContain(
        "untrusted data",
      );
      expect(ROUTE_POLICY_V3[task as PromptedTaskId]).toMatchObject({
        promptId: definition.id,
        promptVersion: definition.version,
      });
    }
  });

  it("versions the discriminated quiz contract without weakening validation", () => {
    const quiz = PROMPT_REGISTRY_V1["assessment.quiz.v1"];

    expect(ROUTE_POLICY_V3["assessment.quiz.v1"].promptVersion).toBe("3");
    expect(quiz.version).toBe("3");
    expect(quiz.outputSchemaId).toBe("quiz-generation-result-v2");
    expect(quiz.outputContract).not.toContain('"responseOptions"?:');
    expect(quiz.outputContract).not.toContain('"rubric"?:');
    expect(quiz.outputContract).toContain(
      '"itemType":"multiple_choice"|"concept_linking"',
    );
    expect(quiz.outputContract).toContain('"itemType":"short_answer"');
    expect(quiz.outputContract).toContain(
      "responseOptions must contain at least two unique strings including keyedAnswer",
    );
    expect(quiz.outputContract).toContain(
      "For short_answer, rubric is required and responseOptions must be absent",
    );
  });

  it("versions the lesson target while retaining the activation bounds", () => {
    const lesson = PROMPT_REGISTRY_V1["lesson.text.v1"];

    expect(ROUTE_POLICY_V3["lesson.text.v1"].promptVersion).toBe("2");
    expect(lesson.version).toBe("2");
    expect(lesson.outputSchemaId).toBe("lesson-result-v1");
    expect(lesson.fixedInstructions.join(" ")).toContain("450 to 550 word");
    expect(lesson.outputContract).toContain(
      "content string must contain 400 to 600 words",
    );
  });

  it("caps attempts and requires proven submission idempotency for media retries", () => {
    for (const route of Object.values(ROUTE_POLICY_V3)) {
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
