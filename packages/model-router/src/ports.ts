import type { ModelTaskId, ModelTaskInput } from "./contracts.js";
import type { PromptBundle } from "./prompts.js";

export type ModelCapability =
  | "dialogue"
  | "embedding"
  | "grading"
  | "grounded_generation"
  | "speech"
  | "structured"
  | "video";

export interface AdapterDescriptor {
  readonly adapterVersion: string;
  readonly capability: ModelCapability;
  readonly driftCanaryPassed: boolean;
  readonly effectiveModel: string;
  readonly effectiveModelVersion: string;
  readonly maxImmediateAttempts: number;
  readonly mediaSubmissionIdempotent: boolean;
  readonly mutableAlias: boolean;
  readonly selector: string;
}

export interface ProviderUsage {
  readonly inputUnits?: number;
  readonly outputUnits?: number;
}

export interface AdapterResponse {
  readonly usage?: ProviderUsage;
  readonly value: unknown;
}

export interface AdapterInvocation<Task extends ModelTaskId = ModelTaskId> {
  readonly input: ModelTaskInput<Task>;
  readonly prompt?: PromptBundle;
  readonly signal: AbortSignal;
  readonly task: Task;
}

interface CapabilityPortBase {
  readonly descriptor: AdapterDescriptor;
}

export interface StructuredModelPort extends CapabilityPortBase {
  executeStructured(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface GroundedGenerationPort extends CapabilityPortBase {
  generateGrounded(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface GradingModelPort extends CapabilityPortBase {
  grade(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface DialogueModelPort extends CapabilityPortBase {
  answerGrounded(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface EmbeddingModelPort extends CapabilityPortBase {
  embed(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface SpeechModelPort extends CapabilityPortBase {
  synthesize(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface VideoModelPort extends CapabilityPortBase {
  generateVideo(invocation: AdapterInvocation): Promise<AdapterResponse>;
}

export interface ModelAdapterRegistry {
  readonly dialogue: Readonly<Record<string, DialogueModelPort>>;
  readonly embedding: Readonly<Record<string, EmbeddingModelPort>>;
  readonly grading: Readonly<Record<string, GradingModelPort>>;
  readonly groundedGeneration: Readonly<Record<string, GroundedGenerationPort>>;
  readonly speech: Readonly<Record<string, SpeechModelPort>>;
  readonly structured: Readonly<Record<string, StructuredModelPort>>;
  readonly video: Readonly<Record<string, VideoModelPort>>;
}

export class ModelAdapterError extends Error {
  readonly safeCode: string;
  readonly submissionState: "accepted" | "not_accepted" | "unknown";
  readonly transient: boolean;

  constructor(options: {
    readonly cause?: unknown;
    readonly message?: string;
    readonly safeCode: string;
    readonly submissionState?: "accepted" | "not_accepted" | "unknown";
    readonly transient: boolean;
  }) {
    super(options.message ?? "model adapter request failed", {
      cause: options.cause,
    });
    this.name = "ModelAdapterError";
    this.safeCode = normalizeSafeCode(options.safeCode);
    this.submissionState = options.submissionState ?? "unknown";
    this.transient = options.transient;
  }
}

const SAFE_ADAPTER_ERROR_CODES = new Set([
  "authentication_failed",
  "capacity_unavailable",
  "invalid_request",
  "provider_error",
  "quota_exhausted",
  "rate_limited",
  "request_rejected",
  "script_exhausted",
  "timeout",
  "unavailable",
]);

function normalizeSafeCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return SAFE_ADAPTER_ERROR_CODES.has(normalized)
    ? normalized
    : "provider_error";
}
