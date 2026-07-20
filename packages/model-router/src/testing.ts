import type { ModelTaskId } from "./contracts.js";
import {
  ModelAdapterError,
  type AdapterDescriptor,
  type AdapterInvocation,
  type AdapterResponse,
  type ModelAdapterRegistry,
  type ModelCapability,
} from "./ports.js";
import type { ModelLogicalCallTrace, ModelTraceSink } from "./trace.js";

export type ScriptedAdapterAction =
  | {
      readonly type: "result";
      readonly usage?: AdapterResponse["usage"];
      readonly value: unknown;
    }
  | {
      readonly cause?: unknown;
      readonly safeCode: string;
      readonly transient: boolean;
      readonly type: "failure";
    };

export type ScriptedAdapterPlan = Partial<
  Record<ModelTaskId, readonly ScriptedAdapterAction[]>
>;

export interface ScriptedAdapterRegistry {
  readonly adapters: ModelAdapterRegistry;
  readonly invocations: readonly AdapterInvocation[];
}

export function createScriptedAdapterRegistry(
  plan: ScriptedAdapterPlan,
): ScriptedAdapterRegistry {
  const queues = new Map(
    Object.entries(plan).map(([task, actions]) => [task, [...actions]]),
  );
  const invocations: AdapterInvocation[] = [];
  const invoke = async (
    invocation: AdapterInvocation,
  ): Promise<AdapterResponse> => {
    invocations.push(invocation);
    const action = queues.get(invocation.task)?.shift();
    if (action === undefined) {
      throw new ModelAdapterError({
        safeCode: "script_exhausted",
        transient: false,
      });
    }
    if (action.type === "failure") {
      throw new ModelAdapterError({
        cause: action.cause,
        safeCode: action.safeCode,
        transient: action.transient,
      });
    }
    return {
      ...(action.usage === undefined ? {} : { usage: action.usage }),
      value: action.value,
    };
  };

  const descriptors = {
    dialogue: descriptor("dialogue", "qwen.dialogue", "qwen-plus"),
    embedding: descriptor("embedding", "embedding-v1", "text-embedding-v4"),
    grading: descriptor("grading", "qwen.grading", "qwen-plus"),
    groundedGeneration: descriptor(
      "grounded_generation",
      "qwen.grounded-generation",
      "qwen-plus",
    ),
    speech: descriptor("speech", "qwen-tts.primary", "qwen-tts", 1),
    structured: descriptor("structured", "qwen.structured", "qwen-plus"),
    video: descriptor("video", "wanx.video", "wanx-2.1", 1),
  };

  return {
    adapters: {
      dialogue: {
        "qwen.dialogue": {
          answerGrounded: invoke,
          descriptor: descriptors.dialogue,
        },
      },
      embedding: {
        "embedding-v1": { descriptor: descriptors.embedding, embed: invoke },
      },
      grading: {
        "qwen.grading": { descriptor: descriptors.grading, grade: invoke },
      },
      groundedGeneration: {
        "qwen.grounded-generation": {
          descriptor: descriptors.groundedGeneration,
          generateGrounded: invoke,
        },
      },
      speech: {
        "qwen-tts.primary": {
          descriptor: descriptors.speech,
          synthesize: invoke,
        },
      },
      structured: {
        "qwen.structured": {
          descriptor: descriptors.structured,
          executeStructured: invoke,
        },
      },
      video: {
        "wanx.video": {
          descriptor: descriptors.video,
          generateVideo: invoke,
        },
      },
    },
    invocations,
  };
}

export class InMemoryTraceSink implements ModelTraceSink {
  readonly traces: ModelLogicalCallTrace[] = [];

  record(trace: ModelLogicalCallTrace): void {
    this.traces.push(trace);
  }
}

function descriptor(
  capability: ModelCapability,
  selector: string,
  effectiveModel: string,
  maxImmediateAttempts = 2,
): AdapterDescriptor {
  return {
    adapterVersion: "scripted-adapter-v1",
    capability,
    driftCanaryPassed: true,
    effectiveModel,
    effectiveModelVersion: "fixture-version-1",
    maxImmediateAttempts,
    mediaSubmissionIdempotent: false,
    mutableAlias: false,
    selector,
  };
}
