import { describe, expect, it } from "vitest";

import { createModelRouter } from "./router.js";
import type { ModelRouterError } from "./router.js";
import { assertSafeTraceEnvelope } from "./trace.js";
import { createScriptedAdapterRegistry, InMemoryTraceSink } from "./testing.js";

describe("typed model router", () => {
  it("routes a Qwen structured task and persists reproducible provenance", async () => {
    const scripted = createScriptedAdapterRegistry({
      "curriculum.structure.v1": [
        {
          type: "result",
          usage: { inputUnits: 120, outputUnits: 30 },
          value: {
            chapters: [
              {
                conceptNames: ["Virtual networks"],
                sourceSpanIds: ["span-1"],
                title: "Networking",
              },
            ],
          },
        },
      ],
    });
    const traces = new InMemoryTraceSink();
    const router = createModelRouter({
      adapters: scripted.adapters,
      callId: () => "call-1",
      now: monotonicClock(),
      traceSink: traces,
    });

    const result = await router.execute(
      "curriculum.structure.v1",
      {
        courseTitle: "Cloud foundations",
        sourceSpans: [{ id: "span-1", text: "A VPC is isolated." }],
      },
      { deadlineMs: 1_000 },
    );

    expect(result.value.chapters[0]?.title).toBe("Networking");
    expect(result.provenance).toMatchObject({
      adapterVersion: "scripted-adapter-v1",
      effectiveModel: "qwen-plus",
      promptId: "curriculum-structure",
      requestedSelector: "qwen.structured",
      routePolicyVersion: "route-policy-v1",
      validationOutcome: "passed",
    });
    expect(result.provenance.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(scripted.invocations).toHaveLength(1);
    expect(scripted.invocations[0]?.prompt?.sourceMaterial).toEqual([
      { id: "span-1", text: "A VPC is isolated." },
    ]);
    expect(scripted.invocations[0]?.prompt?.fixedInstructions).not.toContain(
      "A VPC is isolated.",
    );
    expect(Object.isFrozen(scripted.invocations[0]?.prompt)).toBe(true);
    expect(Object.isFrozen(scripted.invocations[0]?.input)).toBe(false);
    expect(traces.traces).toHaveLength(1);
    expect(traces.traces[0]?.attempts).toHaveLength(1);
  });

  it("retries one normalized transient language failure without tracing diagnostics", async () => {
    const secretDiagnostic =
      "source passage, learner answer, learner@example.com, provider payload";
    const scripted = createScriptedAdapterRegistry({
      "assessment.grade-short-answer.v1": [
        {
          cause: new Error(secretDiagnostic),
          safeCode: "RATE-LIMITED",
          transient: true,
          type: "failure",
        },
        {
          type: "result",
          value: {
            evidence: [
              {
                conceptId: "concept-1",
                confidence: 0.98,
                rubricBand: "correct",
                score: 1,
              },
            ],
          },
        },
      ],
    });
    const traces = new InMemoryTraceSink();
    const router = createModelRouter({
      adapters: scripted.adapters,
      now: monotonicClock(),
      traceSink: traces,
    });

    await router.execute(
      "assessment.grade-short-answer.v1",
      {
        answer: "My private learner answer",
        conceptIds: ["concept-1"],
        question: "My answer and phone are private",
        rubric: "Private rubric",
        sourceSpans: [
          {
            id: "span-private",
            text: "Passage containing private@example.com and +1-555-0100",
          },
        ],
      },
      { deadlineMs: 1_000 },
    );

    expect(scripted.invocations).toHaveLength(2);
    expect(traces.traces[0]?.attempts).toHaveLength(2);
    expect(traces.traces[0]?.attempts[0]).toMatchObject({
      outcome: "transient_error",
      retryReason: "rate_limited",
    });
    const serializedTrace = JSON.stringify(traces.traces);
    for (const prohibited of [
      secretDiagnostic,
      "My answer and phone are private",
      "My private learner answer",
      "private@example.com",
      "+1-555-0100",
      "correct",
    ]) {
      expect(serializedTrace).not.toContain(prohibited);
    }
  });

  it("maps adapter-supplied diagnostic-looking error codes to a closed safe code", async () => {
    const scripted = createScriptedAdapterRegistry({
      "tutor.answer.v1": [
        {
          safeCode: "learner_example_com",
          transient: false,
          type: "failure",
        },
      ],
    });
    const traces = new InMemoryTraceSink();
    const router = createModelRouter({
      adapters: scripted.adapters,
      now: monotonicClock(),
      traceSink: traces,
    });

    await expect(
      router.execute(
        "tutor.answer.v1",
        {
          question: "question",
          sourceSpans: [{ id: "span-1", text: "source" }],
        },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(traces.traces[0]?.attempts[0]?.retryReason).toBe("provider_error");
  });

  it("rejects schema-invalid results and records validation failure", async () => {
    const scripted = createScriptedAdapterRegistry({
      "assessment.quiz.v1": [{ type: "result", value: { items: "invalid" } }],
    });
    const traces = new InMemoryTraceSink();
    const router = createModelRouter({
      adapters: scripted.adapters,
      now: monotonicClock(),
      traceSink: traces,
    });

    await expect(
      router.execute(
        "assessment.quiz.v1",
        {
          conceptIds: ["concept-1"],
          count: 1,
          courseId: "course-1",
          sourceSpans: [{ id: "span-1", text: "Grounding" }],
        },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject<Partial<ModelRouterError>>({
      code: "invalid_result",
    });
    expect(traces.traces[0]?.attempts[0]).toMatchObject({
      outcome: "validation_error",
      validationStatus: "failed",
    });
  });

  it("keeps the P1 video route unavailable unless the server guard admits it", async () => {
    const scripted = createScriptedAdapterRegistry({
      "media.video.v1": [
        {
          type: "result",
          value: {
            durationSeconds: 90,
            mimeType: "video/mp4",
            sourceSpanIds: ["span-1"],
            uri: "oss://private/video.mp4",
          },
        },
      ],
    });
    const router = createModelRouter({
      adapters: scripted.adapters,
      isFeatureEnabled: async () => false,
      traceSink: new InMemoryTraceSink(),
    });

    await expect(
      router.execute(
        "media.video.v1",
        {
          conceptId: "concept-1",
          sourceSpans: [{ id: "span-1", text: "Grounding" }],
          visualBrief: "Explain with a moving diagram",
        },
        { deadlineMs: 1_000, videoOperationKind: "chapter_explainer" },
      ),
    ).rejects.toMatchObject<Partial<ModelRouterError>>({
      code: "feature_disabled",
    });
    expect(scripted.invocations).toHaveLength(0);
  });

  it("fails the P1 route closed when its authoritative guard is unavailable", async () => {
    const scripted = createScriptedAdapterRegistry({});
    const router = createModelRouter({
      adapters: scripted.adapters,
      isFeatureEnabled: async () => {
        throw new Error("flag database unavailable");
      },
      traceSink: new InMemoryTraceSink(),
    });

    await expect(
      router.execute(
        "media.video.v1",
        {
          conceptId: "concept-1",
          sourceSpans: [{ id: "span-1", text: "Grounding" }],
          visualBrief: "Explain with a moving diagram",
        },
        { deadlineMs: 1_000, videoOperationKind: "chapter_explainer" },
      ),
    ).rejects.toMatchObject({ code: "feature_disabled" });
    expect(scripted.invocations).toHaveLength(0);
  });
});

describe("trace allowlist", () => {
  it("rejects prompt, answer, contact, content, payload, and diagnostic fields", () => {
    for (const field of [
      "answer",
      "contactDetails",
      "generatedContent",
      "prompt",
      "providerPayload",
      "rawDiagnostic",
      "sourcePassage",
    ]) {
      expect(() =>
        assertSafeTraceEnvelope({
          attempts: [],
          callId: "call-1",
          durationMs: 1,
          finishedAt: "2026-07-19T00:00:00.001Z",
          outcome: "success",
          routePolicyVersion: "route-policy-v1",
          startedAt: "2026-07-19T00:00:00.000Z",
          task: "curriculum.structure.v1",
          [field]: "secret",
        } as never),
      ).toThrow("non-allowlisted fields");
    }
  });
});

function monotonicClock(): () => number {
  let value = Date.parse("2026-07-19T00:00:00.000Z");
  return () => {
    value += 1;
    return value;
  };
}
