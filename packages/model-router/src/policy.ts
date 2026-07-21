import type { ModelTaskId } from "./contracts.js";
import type { ModelCapability } from "./ports.js";

export const ROUTE_POLICY_VERSION = "route-policy-v2" as const;

export interface RouteDefinition {
  readonly capability: ModelCapability;
  readonly featureFlag?: "p1.media.video";
  readonly fallback: null;
  readonly inputSchemaVersion: string;
  readonly maxImmediateAttempts: 1 | 2;
  readonly mediaRetryRequiresSubmissionIdempotency?: true;
  readonly promptId?: string;
  readonly promptVersion?: string;
  readonly requestedSelector: string;
  readonly resultSchemaVersion: string;
  readonly task: ModelTaskId;
  readonly textType?: "document" | "query";
}

export const ROUTE_POLICY_V2 = Object.freeze({
  "assessment.grade-short-answer.v1": route({
    capability: "grading",
    fallback: null,
    inputSchemaVersion: "short-answer-grading-input-v1",
    maxImmediateAttempts: 2,
    promptId: "assessment-grade-short-answer",
    promptVersion: "1",
    requestedSelector: "qwen.grading",
    resultSchemaVersion: "short-answer-evidence-candidate-v1",
    task: "assessment.grade-short-answer.v1",
  }),
  "assessment.quiz.v1": route({
    capability: "structured",
    fallback: null,
    inputSchemaVersion: "quiz-generation-input-v2",
    maxImmediateAttempts: 2,
    promptId: "assessment-quiz",
    promptVersion: "2",
    requestedSelector: "qwen.structured",
    resultSchemaVersion: "quiz-generation-result-v2",
    task: "assessment.quiz.v1",
  }),
  "curriculum.structure.v1": route({
    capability: "structured",
    fallback: null,
    inputSchemaVersion: "curriculum-structure-input-v1",
    maxImmediateAttempts: 2,
    promptId: "curriculum-structure",
    promptVersion: "1",
    requestedSelector: "qwen.structured",
    resultSchemaVersion: "curriculum-structure-result-v1",
    task: "curriculum.structure.v1",
  }),
  "embedding.document.v1": route({
    capability: "embedding",
    fallback: null,
    inputSchemaVersion: "embedding-input-v1",
    maxImmediateAttempts: 2,
    requestedSelector: "embedding-v1",
    resultSchemaVersion: "embedding-result-v1",
    task: "embedding.document.v1",
    textType: "document",
  }),
  "embedding.query.v1": route({
    capability: "embedding",
    fallback: null,
    inputSchemaVersion: "embedding-input-v1",
    maxImmediateAttempts: 2,
    requestedSelector: "embedding-v1",
    resultSchemaVersion: "embedding-result-v1",
    task: "embedding.query.v1",
    textType: "query",
  }),
  "lesson.audio-script.v1": route({
    capability: "grounded_generation",
    fallback: null,
    inputSchemaVersion: "lesson-input-v1",
    maxImmediateAttempts: 2,
    promptId: "lesson-audio-script",
    promptVersion: "1",
    requestedSelector: "qwen.grounded-generation",
    resultSchemaVersion: "audio-script-result-v1",
    task: "lesson.audio-script.v1",
  }),
  "lesson.reteach.v1": route({
    capability: "grounded_generation",
    fallback: null,
    inputSchemaVersion: "lesson-input-v1",
    maxImmediateAttempts: 2,
    promptId: "lesson-reteach",
    promptVersion: "1",
    requestedSelector: "qwen.grounded-generation",
    resultSchemaVersion: "lesson-result-v1",
    task: "lesson.reteach.v1",
  }),
  "lesson.text.v1": route({
    capability: "grounded_generation",
    fallback: null,
    inputSchemaVersion: "lesson-input-v1",
    maxImmediateAttempts: 2,
    promptId: "lesson-text",
    promptVersion: "1",
    requestedSelector: "qwen.grounded-generation",
    resultSchemaVersion: "lesson-result-v1",
    task: "lesson.text.v1",
  }),
  "media.tts.v1": route({
    capability: "speech",
    fallback: null,
    inputSchemaVersion: "text-to-speech-input-v1",
    maxImmediateAttempts: 2,
    mediaRetryRequiresSubmissionIdempotency: true,
    requestedSelector: "qwen-tts.primary",
    resultSchemaVersion: "audio-asset-result-v1",
    task: "media.tts.v1",
  }),
  "media.video.v1": route({
    capability: "video",
    fallback: null,
    featureFlag: "p1.media.video",
    inputSchemaVersion: "video-generation-input-v1",
    maxImmediateAttempts: 2,
    mediaRetryRequiresSubmissionIdempotency: true,
    promptId: "media-video",
    promptVersion: "1",
    requestedSelector: "wanx.video",
    resultSchemaVersion: "video-asset-result-v1",
    task: "media.video.v1",
  }),
  "tutor.answer.v1": route({
    capability: "dialogue",
    fallback: null,
    inputSchemaVersion: "tutor-answer-input-v1",
    maxImmediateAttempts: 2,
    promptId: "tutor-answer",
    promptVersion: "1",
    requestedSelector: "qwen.dialogue",
    resultSchemaVersion: "tutor-answer-result-v1",
    task: "tutor.answer.v1",
  }),
} as const satisfies Record<ModelTaskId, RouteDefinition>);

function route<const Definition extends RouteDefinition>(
  definition: Definition,
): Definition {
  return Object.freeze(definition);
}
