import { describe, expect, it } from "vitest";

import { createModelRouter } from "../router.js";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "../testing.js";
import {
  createModelStudioVideoAdapter,
  WAN_2_7_MODEL,
} from "./model-studio-video.js";

const apiKey = "secret-api-key-fixture";
const endpoint =
  "https://workspace-1.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis";
const taskId = "task_12345678";
const input = {
  conceptId: "concept-1",
  sourceSpans: [{ id: "span-1", text: "Private source passage" }],
  visualBrief: "Animate packets moving through a virtual network diagram.",
} as const;
const baseOptions = {
  adapterVersion: "model-studio-wan-video-v1",
  apiKey,
  driftCanaryPassed: true,
  effectiveModelVersion: "wan2.7-t2v-2026-06-12",
  enabled: true,
  endpoint,
  model: WAN_2_7_MODEL,
  region: "ap-southeast-1",
} as const;

describe("Model Studio Wan video adapter", () => {
  it("is unavailable until explicitly enabled with current canary evidence", () => {
    for (const override of [
      { driftCanaryPassed: false, enabled: true },
      { driftCanaryPassed: true, enabled: false },
    ]) {
      expect(() =>
        createModelStudioVideoAdapter({ ...baseOptions, ...override }),
      ).toThrow("unavailable");
    }
  });

  it("rejects credentials, mutable models, and endpoints outside the selected workspace region", () => {
    for (const override of [
      { apiKey: "short" },
      { apiKey: "key\nheader-injection" },
      { model: "wan2.7-t2v" as typeof WAN_2_7_MODEL },
      { endpoint: "https://attacker.invalid/video-synthesis" },
      {
        endpoint:
          "https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      },
    ]) {
      expect(() =>
        createModelStudioVideoAdapter({ ...baseOptions, ...override }),
      ).toThrow();
    }
  });

  it("submits once, polls pending states, and normalizes a successful clip", async () => {
    const scripted = scriptedFetch([
      jsonResponse(submission()),
      jsonResponse(status("PENDING")),
      jsonResponse(status("RUNNING")),
      jsonResponse(success()),
    ]);
    const adapter = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: scripted.fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    const response = await invoke(adapter);

    expect(response).toEqual({
      identity: {
        effectiveModel: WAN_2_7_MODEL,
        providerRequestId: taskId,
      },
      usage: { outputUnits: 15 },
      value: {
        durationSeconds: 15,
        mimeType: "video/mp4",
        sourceSpanIds: ["span-1"],
        uri: "https://dashscope-result-sh.oss-accelerate.aliyuncs.com/synthetic/output.mp4?Expires=123",
      },
    });
    expect(scripted.calls).toHaveLength(4);
    const submissionCall = scripted.calls[0];
    expect(submissionCall?.url).toBe(endpoint);
    expect(submissionCall?.init?.method).toBe("POST");
    const headers = new Headers(submissionCall?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("x-dashscope-async")).toBe("enable");
    const body = String(submissionCall?.init?.body);
    expect(JSON.parse(body)).toEqual({
      input: { prompt: input.visualBrief },
      model: WAN_2_7_MODEL,
      parameters: {
        duration: 15,
        prompt_extend: false,
        ratio: "16:9",
        resolution: "720P",
        watermark: true,
      },
    });
    expect(body).not.toContain(input.sourceSpans[0].text);
    expect(scripted.calls.slice(1).map((call) => call.url)).toEqual([
      "https://workspace-1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task_12345678",
      "https://workspace-1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task_12345678",
      "https://workspace-1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task_12345678",
    ]);
  });

  it("normalizes rejection, provider failure, and unknown completion without raw diagnostics", async () => {
    const rejected = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: async () => new Response(`private ${apiKey}`, { status: 429 }),
    });
    await expect(invoke(rejected)).rejects.toMatchObject({
      safeCode: "rate_limited",
      submissionState: "not_accepted",
      transient: true,
    });

    const failed = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse({
          ...status("FAILED"),
          output: {
            ...status("FAILED").output,
            code: "AllocationQuotaExceeded",
            message: `private diagnostic ${apiKey}`,
          },
        }),
      ]).fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    let thrown: unknown;
    try {
      await invoke(failed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      safeCode: "quota_exhausted",
      submissionState: "accepted",
      transient: true,
    });
    expect(JSON.stringify(thrown)).not.toContain(apiKey);

    const unknown = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse(status("UNKNOWN")),
      ]).fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    await expect(invoke(unknown)).rejects.toMatchObject({
      safeCode: "provider_error",
      submissionState: "accepted",
      transient: false,
    });
  });

  it("rejects unsafe or inconsistent media metadata", async () => {
    for (const override of [
      { output: { ...success().output, video_url: "https://127.0.0.1/x" } },
      { usage: { ...success().usage, output_video_duration: 5 } },
      { usage: { ...success().usage, SR: 1080 } },
      { usage: { ...success().usage, size: "1920*1080" } },
      { usage: { ...success().usage, video_count: 2 } },
    ]) {
      const adapter = createModelStudioVideoAdapter({
        ...baseOptions,
        fetch: scriptedFetch([
          jsonResponse(submission()),
          jsonResponse({ ...success(), ...override }),
        ]).fetch,
        pollIntervalMs: 0,
        wait: async () => undefined,
      });
      await expect(invoke(adapter)).rejects.toMatchObject({
        safeCode: "provider_error",
        submissionState: "accepted",
        transient: false,
      });
    }
  });

  it("reports timeout as accepted and does not resubmit", async () => {
    const scripted = scriptedFetch([
      jsonResponse(submission()),
      jsonResponse(status("RUNNING")),
    ]);
    const adapter = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: scripted.fetch,
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
    expect(
      scripted.calls.filter((call) => call.init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("runs through the P1-guarded router with authoritative provenance", async () => {
    const wan = createModelStudioVideoAdapter({
      ...baseOptions,
      fetch: scriptedFetch([
        jsonResponse(submission()),
        jsonResponse(success()),
      ]).fetch,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    const base = createScriptedAdapterRegistry({}).adapters;
    const router = createModelRouter({
      adapters: { ...base, video: { "wanx.video": wan } },
      deployment: "staging",
      isFeatureEnabled: async (_key, context) =>
        context.videoOperationKind === "chapter_explainer",
      traceSink: new InMemoryTraceSink(),
    });

    const result = await router.execute("media.video.v1", input, {
      deadlineMs: 1_000,
      videoOperationKind: "chapter_explainer",
    });

    expect(result.provenance).toMatchObject({
      adapterVersion: "model-studio-wan-video-v1",
      evidenceClassification: "authoritative",
      effectiveModel: WAN_2_7_MODEL,
      effectiveModelVersion: "wan2.7-t2v-2026-06-12",
      providerRequestId: taskId,
      requestedSelector: "wanx.video",
      validationOutcome: "passed",
    });
  });
});

function submission() {
  return {
    output: { task_id: taskId, task_status: "PENDING" },
    request_id: "submit_request_12345678",
  };
}

function status(taskStatus: string) {
  return {
    output: { task_id: taskId, task_status: taskStatus },
    request_id: "poll_request_12345678",
  };
}

function success() {
  return {
    output: {
      task_id: taskId,
      task_status: "SUCCEEDED",
      video_url:
        "https://dashscope-result-sh.oss-accelerate.aliyuncs.com/synthetic/output.mp4?Expires=123",
    },
    request_id: "success_request_12345678",
    usage: {
      video_count: 1,
    },
  };
}

function invoke(adapter: ReturnType<typeof createModelStudioVideoAdapter>) {
  return adapter.generateVideo({
    input,
    signal: new AbortController().signal,
    task: "media.video.v1",
  });
}

function jsonResponse(value: unknown, responseStatus = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: responseStatus,
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
