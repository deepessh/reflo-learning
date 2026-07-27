import { describe, expect, it } from "vitest";

import { MODEL_TASK_IDS } from "./contracts.js";
import { ROUTE_POLICY_V6 } from "./policy.js";
import { PROMPT_REGISTRY_V1, type PromptedTaskId } from "./prompts.js";

describe("route-policy-v6", () => {
  it("contains every semantic task exactly once", () => {
    expect(Object.keys(ROUTE_POLICY_V6).sort()).toEqual(
      [...MODEL_TASK_IDS].sort(),
    );
    for (const task of MODEL_TASK_IDS) {
      expect(ROUTE_POLICY_V6[task].task).toBe(task);
      expect(ROUTE_POLICY_V6[task].fallback).toBe(
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
      expect(ROUTE_POLICY_V6[task as PromptedTaskId]).toMatchObject({
        promptId: definition.id,
        promptVersion: definition.version,
      });
    }
  });

  it("versions the discriminated quiz contract without weakening validation", () => {
    const quiz = PROMPT_REGISTRY_V1["assessment.quiz.v1"];

    expect(ROUTE_POLICY_V6["assessment.quiz.v1"].promptVersion).toBe("3");
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

    expect(ROUTE_POLICY_V6["lesson.text.v1"].promptVersion).toBe("2");
    expect(lesson.version).toBe("2");
    expect(lesson.outputSchemaId).toBe("lesson-result-v1");
    expect(lesson.fixedInstructions.join(" ")).toContain("450 to 550 word");
    expect(lesson.outputContract).toContain(
      "content string must contain 400 to 600 words",
    );
  });

  it("keeps segmented curriculum generation separately versioned", () => {
    const route = ROUTE_POLICY_V6["curriculum.segment.v1"];
    const prompt = PROMPT_REGISTRY_V1["curriculum.segment.v1"];

    expect(route).toMatchObject({
      fallback: null,
      inputSchemaVersion: "curriculum-segment-input-v1",
      promptVersion: "2",
      requestedSelector: "qwen.structured",
      resultSchemaVersion: "curriculum-segment-result-v1",
    });
    expect(prompt.generationParametersVersion).toBe(
      "curriculum-segment-generation-parameters-v1",
    );
    expect(prompt.outputSchemaId).toBe("curriculum-segment-provider-result-v2");
    expect(prompt.outputContract).toContain('"kind":"non_instructional"');
    expect(prompt.outputContract).not.toContain('"segmentId"');
    expect(prompt.outputContract).not.toContain('"segmentOrdinal"');
    expect(prompt.outputContract).not.toContain(
      '"kind":"non_instructional","sourceSpanIds"',
    );
  });

  it("caps attempts and requires proven submission idempotency for media retries", () => {
    for (const route of Object.values(ROUTE_POLICY_V6)) {
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
