import { describe, expect, it } from "vitest";

import { createModelRouter } from "./router.js";
import type { ModelRouterError } from "./router.js";
import { assertSafeTraceEnvelope } from "./trace.js";
import { createScriptedAdapterRegistry, InMemoryTraceSink } from "./testing.js";
import { EMBEDDING_V1_DIMENSIONS } from "./validation.js";

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
                concepts: [
                  {
                    key: "virtual-networks",
                    name: "Virtual networks",
                    prerequisiteKeys: [],
                    sourceSpanIds: ["span-1"],
                  },
                ],
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

  it("rejects unauthorized provenance and undeclared result fields", async () => {
    for (const value of [
      {
        chapters: [
          {
            concepts: [
              {
                key: "networking",
                name: "Networking",
                prerequisiteKeys: [],
                sourceSpanIds: ["span-1"],
              },
            ],
            sourceSpanIds: ["span-not-authorized"],
            title: "Chapter",
          },
        ],
      },
      {
        chapters: [
          {
            concepts: [
              {
                key: "networking",
                name: "Networking",
                prerequisiteKeys: [],
                sourceSpanIds: ["span-1"],
              },
            ],
            providerPayload: "must not persist",
            sourceSpanIds: ["span-1"],
            title: "Chapter",
          },
        ],
      },
    ]) {
      const scripted = createScriptedAdapterRegistry({
        "curriculum.structure.v1": [{ type: "result", value }],
      });
      const router = createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      });

      await expect(
        router.execute(
          "curriculum.structure.v1",
          {
            courseTitle: "Course",
            sourceSpans: [{ id: "span-1", text: "Authorized source" }],
          },
          { deadlineMs: 1_000 },
        ),
      ).rejects.toMatchObject({ code: "invalid_result" });
    }

    const scripted = createScriptedAdapterRegistry({
      "assessment.grade-short-answer.v1": [
        {
          type: "result",
          value: {
            evidence: [
              {
                conceptId: "concept-not-authorized",
                confidence: 0.99,
                rubricBand: "correct",
                score: 1,
              },
            ],
          },
        },
      ],
    });
    const router = createModelRouter({
      adapters: scripted.adapters,
      traceSink: new InMemoryTraceSink(),
    });
    await expect(
      router.execute(
        "assessment.grade-short-answer.v1",
        {
          answer: "Answer",
          conceptIds: ["concept-1"],
          question: "Question",
          rubric: "Rubric",
          sourceSpans: [{ id: "span-1", text: "Source" }],
        },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "invalid_result" });
  });

  it("requires one 1024-dimensional embedding per input text", async () => {
    const validVector = Array.from(
      { length: EMBEDDING_V1_DIMENSIONS },
      () => 0.25,
    );
    for (const vectors of [[], [[0.25, 0.5]], [validVector, validVector]]) {
      const scripted = createScriptedAdapterRegistry({
        "embedding.document.v1": [
          {
            type: "result",
            value: {
              metadata: embeddingMetadata("document"),
              vectors,
            },
          },
        ],
      });
      const router = createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      });

      await expect(
        router.execute(
          "embedding.document.v1",
          { texts: ["one source chunk"] },
          { deadlineMs: 1_000 },
        ),
      ).rejects.toMatchObject({ code: "invalid_result" });
    }

    const scripted = createScriptedAdapterRegistry({
      "embedding.document.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("document"),
            vectors: [validVector],
          },
        },
      ],
    });
    const router = createModelRouter({
      adapters: scripted.adapters,
      traceSink: new InMemoryTraceSink(),
    });
    await expect(
      router.execute(
        "embedding.document.v1",
        { texts: ["one source chunk"] },
        { deadlineMs: 1_000 },
      ),
    ).resolves.toMatchObject({ value: { vectors: [validVector] } });

    const wrongMode = createScriptedAdapterRegistry({
      "embedding.document.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("query"),
            vectors: [validVector],
          },
        },
      ],
    });
    await expect(
      createModelRouter({
        adapters: wrongMode.adapters,
        traceSink: new InMemoryTraceSink(),
      }).execute(
        "embedding.document.v1",
        { texts: ["one source chunk"] },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "invalid_result" });
  });

  it("requires concept provenance and backward-only prerequisite keys", async () => {
    const scripted = createScriptedAdapterRegistry({
      "curriculum.structure.v1": [
        {
          type: "result",
          value: {
            chapters: [
              {
                concepts: [
                  {
                    key: "advanced",
                    name: "Advanced",
                    prerequisiteKeys: ["not-seen-yet"],
                    sourceSpanIds: ["span-1"],
                  },
                ],
                sourceSpanIds: ["span-1"],
                title: "Chapter",
              },
            ],
          },
        },
      ],
    });

    await expect(
      createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      }).execute(
        "curriculum.structure.v1",
        {
          courseTitle: "Course",
          sourceSpans: [{ id: "span-1", text: "Authorized source" }],
        },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "invalid_result" });
  });

  it("bounds a never-settling provider call by the caller deadline and aborts it", async () => {
    const scripted = createScriptedAdapterRegistry({
      "curriculum.structure.v1": [{ type: "pending" }],
    });
    const traces = new InMemoryTraceSink();
    const router = createModelRouter({
      adapters: scripted.adapters,
      traceSink: traces,
    });
    const startedAt = Date.now();

    await expect(
      router.execute(
        "curriculum.structure.v1",
        {
          courseTitle: "Course",
          sourceSpans: [{ id: "span-1", text: "Source" }],
        },
        { deadlineMs: 25 },
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(scripted.invocations[0]?.signal.aborted).toBe(true);
    expect(traces.traces[0]?.attempts[0]?.outcome).toBe("deadline_exceeded");
  });

  it("includes the feature guard in the caller's total deadline", async () => {
    const scripted = createScriptedAdapterRegistry({});
    const router = createModelRouter({
      adapters: scripted.adapters,
      isFeatureEnabled: () => new Promise<boolean>(() => undefined),
      traceSink: new InMemoryTraceSink(),
    });
    const startedAt = Date.now();

    await expect(
      router.execute(
        "media.video.v1",
        {
          conceptId: "concept-1",
          sourceSpans: [{ id: "span-1", text: "Grounding" }],
          visualBrief: "Explain visually",
        },
        { deadlineMs: 25, videoOperationKind: "chapter_explainer" },
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(scripted.invocations).toHaveLength(0);
  });

  it("aborts a hanging trace write without emitting a second logical trace", async () => {
    const scripted = createScriptedAdapterRegistry({
      "curriculum.structure.v1": [
        {
          type: "result",
          value: {
            chapters: [
              {
                concepts: [
                  {
                    key: "concept",
                    name: "Concept",
                    prerequisiteKeys: [],
                    sourceSpanIds: ["span-1"],
                  },
                ],
                sourceSpanIds: ["span-1"],
                title: "Chapter",
              },
            ],
          },
        },
      ],
    });
    const receivedTraces: unknown[] = [];
    let traceAborted = false;
    const router = createModelRouter({
      adapters: scripted.adapters,
      traceSink: {
        record(trace, signal) {
          receivedTraces.push(trace);
          return new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                traceAborted = true;
                resolve();
              },
              { once: true },
            );
          });
        },
      },
    });

    await expect(
      router.execute(
        "curriculum.structure.v1",
        {
          courseTitle: "Course",
          sourceSpans: [{ id: "span-1", text: "Source" }],
        },
        { deadlineMs: 25 },
      ),
    ).rejects.toMatchObject({ code: "trace_failure" });

    expect(scripted.invocations).toHaveLength(1);
    expect(receivedTraces).toHaveLength(1);
    expect(receivedTraces[0]).toMatchObject({
      attempts: [{ attempt: 1, outcome: "success" }],
      outcome: "success",
    });
    expect(traceAborted).toBe(true);
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

function embeddingMetadata(inputMode: "document" | "query") {
  return {
    dimensions: EMBEDDING_V1_DIMENSIONS,
    endpoint: "model-studio.example.invalid",
    inputMode,
    providerIdentifier: "model-studio",
    providerRequestId: "request-fixture-1",
    region: "fixture-region-1",
  } as const;
}

function monotonicClock(): () => number {
  let value = Date.parse("2026-07-19T00:00:00.000Z");
  return () => {
    value += 1;
    return value;
  };
}
