import { describe, expect, it } from "vitest";

import { createModelRouter } from "../router.js";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "../testing.js";
import { createFalDevVideoAdapter } from "./fal.js";

const model = "fal-ai/wan/v2.7/text-to-video";
const requestId = "request_12345678";
const environment = {
  REFLO_ENV: "dev",
  REFLO_FAL_KEY: "dev-only-placeholder",
  REFLO_FAL_MEDIA_LIFETIME_SECONDS: "3600",
  REFLO_FAL_VIDEO_MODEL: model,
} as const;
const input = {
  conceptId: "concept-1",
  sourceSpans: [{ id: "span-1", text: "Private source passage" }],
  visualBrief: "Animate packets moving through a virtual network diagram.",
} as const;

describe("fal development video adapter", () => {
  it("rejects staging and pilot composition", () => {
    for (const deployment of ["staging", "pilot"] as const) {
      expect(() =>
        createFalDevVideoAdapter({ ...environment, REFLO_ENV: deployment }),
      ).toThrow("only when REFLO_ENV=dev");
    }
  });

  it("fails closed on invalid credentials, model identifiers, and lifetimes", () => {
    for (const override of [
      { REFLO_FAL_KEY: "short" },
      { REFLO_FAL_KEY: "key\nheader-injection" },
      { REFLO_FAL_VIDEO_MODEL: "https://queue.fal.run/model" },
      { REFLO_FAL_VIDEO_MODEL: "single-segment" },
      { REFLO_FAL_MEDIA_LIFETIME_SECONDS: "299" },
      { REFLO_FAL_MEDIA_LIFETIME_SECONDS: "86401" },
      { REFLO_FAL_MEDIA_LIFETIME_SECONDS: "forever" },
    ]) {
      expect(() =>
        createFalDevVideoAdapter({ ...environment, ...override }),
      ).toThrow();
    }
  });

  it("submits once, polls pending states, and normalizes a successful result", async () => {
    const scripted = scriptedFetch([
      jsonResponse(submission()),
      jsonResponse({ request_id: requestId, status: "IN_QUEUE" }),
      jsonResponse({ request_id: requestId, status: "IN_PROGRESS" }),
      jsonResponse({ request_id: requestId, status: "COMPLETED" }),
      jsonResponse({
        video: {
          content_type: "video/mp4",
          duration: 5,
          file_name: "provider-controlled-name.mp4",
          file_size: 1_024,
          url: "https://v3b.fal.media/files/synthetic/output.mp4",
        },
      }),
    ]);
    const adapter = createFalDevVideoAdapter(environment, {
      fetch: scripted.fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    const response = await adapter.generateVideo({
      input,
      prompt: undefined,
      signal: new AbortController().signal,
      task: "media.video.v1",
    });

    expect(response).toEqual({
      identity: { effectiveModel: model, providerRequestId: requestId },
      value: {
        durationSeconds: 5,
        mimeType: "video/mp4",
        sourceSpanIds: ["span-1"],
        uri: "https://v3b.fal.media/files/synthetic/output.mp4",
      },
    });
    expect(Object.keys(response.value as object).sort()).toEqual([
      "durationSeconds",
      "mimeType",
      "sourceSpanIds",
      "uri",
    ]);
    expect(scripted.calls).toHaveLength(5);
    const submissionCall = scripted.calls[0];
    expect(submissionCall?.url).toBe(
      "https://queue.fal.run/fal-ai/wan/v2.7/text-to-video",
    );
    expect(submissionCall?.init?.method).toBe("POST");
    const headers = new Headers(submissionCall?.init?.headers);
    expect(headers.get("authorization")).toBe("Key dev-only-placeholder");
    expect(headers.get("x-fal-store-io")).toBe("0");
    expect(headers.get("x-fal-no-retry")).toBe("1");
    expect(headers.get("x-app-fal-disable-fallback")).toBe("true");
    expect(headers.get("x-fal-object-lifecycle-preference")).toBe(
      '{"expiration_duration_seconds":3600}',
    );
    const body = String(submissionCall?.init?.body);
    expect(JSON.parse(body)).toEqual({
      aspect_ratio: "16:9",
      duration: 5,
      enable_safety_checker: true,
      prompt: input.visualBrief,
      resolution: "720p",
    });
    expect(body).not.toContain(input.sourceSpans[0].text);
  });

  it("normalizes known rejection and completed-provider failures", async () => {
    const rejected = createFalDevVideoAdapter(environment, {
      fetch: async () => new Response("busy", { status: 429 }),
      pollIntervalMs: 0,
    });
    await expect(invoke(rejected)).rejects.toMatchObject({
      safeCode: "rate_limited",
      submissionState: "not_accepted",
      transient: true,
    });

    const completedFailure = createFalDevVideoAdapter(environment, {
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse({
          error: "provider diagnostic is not exposed",
          error_type: "capacity_exhausted",
          request_id: requestId,
          status: "COMPLETED",
        }),
      ]).fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    await expect(invoke(completedFailure)).rejects.toMatchObject({
      safeCode: "capacity_unavailable",
      submissionState: "accepted",
      transient: true,
    });
  });

  it("rejects unknown completion states and invalid media metadata", async () => {
    const unknown = createFalDevVideoAdapter(environment, {
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse({ request_id: requestId, status: "CANCELLED" }),
      ]).fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    await expect(invoke(unknown)).rejects.toMatchObject({
      safeCode: "provider_error",
      submissionState: "accepted",
      transient: false,
    });

    for (const video of [
      {
        content_type: "image/png",
        url: "https://v3b.fal.media/files/synthetic/output.png",
      },
      {
        content_type: "video/mp4",
        url: "https://127.0.0.1/private-output",
      },
    ]) {
      const invalidMedia = createFalDevVideoAdapter(environment, {
        fetch: scriptedFetch([
          jsonResponse(submission()),
          jsonResponse({ request_id: requestId, status: "COMPLETED" }),
          jsonResponse({ video }),
        ]).fetch,
        pollIntervalMs: 0,
        wait: async () => undefined,
      });
      await expect(invoke(invalidMedia)).rejects.toMatchObject({
        safeCode: "provider_error",
        submissionState: "accepted",
        transient: false,
      });
    }
  });

  it("reports a timeout as accepted after submission", async () => {
    const adapter = createFalDevVideoAdapter(environment, {
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse({ request_id: requestId, status: "IN_PROGRESS" }),
      ]).fetch,
      pollIntervalMs: 1,
      wait: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    await expect(invoke(adapter)).rejects.toMatchObject({
      safeCode: "timeout",
      submissionState: "accepted",
      transient: true,
    });
  });

  it("runs through the P1-guarded router only in development", async () => {
    const fetchScript = scriptedFetch([
      jsonResponse(submission()),
      jsonResponse({ request_id: requestId, status: "COMPLETED" }),
      jsonResponse({
        video: {
          content_type: "video/mp4",
          url: "https://v3b.fal.media/files/synthetic/output.mp4",
        },
      }),
    ]);
    const fal = createFalDevVideoAdapter(environment, {
      fetch: fetchScript.fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    const base = createScriptedAdapterRegistry({}).adapters;
    const adapters = { ...base, video: { "wanx.video": fal } };
    const router = createModelRouter({
      adapters,
      deployment: "dev",
      isFeatureEnabled: async () => true,
      traceSink: new InMemoryTraceSink(),
    });

    const result = await router.execute("media.video.v1", input, {
      deadlineMs: 1_000,
      videoOperationKind: "chapter_explainer",
    });
    expect(result.provenance).toMatchObject({
      adapterVersion: "fal-queue-dev-v1",
      evidenceClassification: "development_only",
      effectiveModel: model,
      providerRequestId: requestId,
      requestedSelector: "wanx.video",
      validationOutcome: "passed",
    });

    const staging = createModelRouter({
      adapters,
      deployment: "staging",
      isFeatureEnabled: async () => true,
      traceSink: new InMemoryTraceSink(),
    });
    await expect(
      staging.execute("media.video.v1", input, {
        deadlineMs: 1_000,
        videoOperationKind: "chapter_explainer",
      }),
    ).rejects.toMatchObject({ code: "invalid_adapter_configuration" });
  });

  it("does not alter text or audio adapter composition", () => {
    const base = createScriptedAdapterRegistry({}).adapters;
    const fal = createFalDevVideoAdapter(environment, {
      fetch: async () => {
        throw new Error("video must not be called");
      },
    });
    const withFal = { ...base, video: { "wanx.video": fal } };

    expect(withFal.dialogue).toBe(base.dialogue);
    expect(withFal.embedding).toBe(base.embedding);
    expect(withFal.grading).toBe(base.grading);
    expect(withFal.groundedGeneration).toBe(base.groundedGeneration);
    expect(withFal.speech).toBe(base.speech);
    expect(withFal.structured).toBe(base.structured);
  });
});

function submission() {
  const base = `https://queue.fal.run/${model}/requests/${requestId}`;
  return {
    cancel_url: `${base}/cancel`,
    request_id: requestId,
    response_url: `${base}/response`,
    status_url: `${base}/status`,
  };
}

function invoke(adapter: ReturnType<typeof createFalDevVideoAdapter>) {
  return adapter.generateVideo({
    input,
    signal: new AbortController().signal,
    task: "media.video.v1",
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function scriptedFetch(responses: readonly Response[]) {
  const queue = [...responses];
  const calls: { readonly init?: RequestInit; readonly url: string }[] = [];
  const fetchImplementation: typeof globalThis.fetch = async (
    request,
    init,
  ) => {
    calls.push({
      ...(init === undefined ? {} : { init }),
      url: request instanceof URL ? request.toString() : String(request),
    });
    const response = queue.shift();
    if (response === undefined) throw new Error("fetch script exhausted");
    return response;
  };
  return { calls, fetch: fetchImplementation };
}
