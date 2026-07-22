export const MODEL_TASK_IDS = [
  "curriculum.structure.v1",
  "lesson.text.v1",
  "lesson.reteach.v1",
  "lesson.audio-script.v1",
  "assessment.quiz.v1",
  "assessment.grade-short-answer.v1",
  "tutor.answer.v1",
  "embedding.document.v1",
  "embedding.query.v1",
  "media.tts.v1",
  "media.video.v1",
] as const;

export type ModelTaskId = (typeof MODEL_TASK_IDS)[number];

export interface AuthorizedSourceSpan {
  readonly id: string;
  readonly text: string;
}

export interface CurriculumStructureInput {
  readonly courseTitle: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface LessonInput {
  readonly conceptId: string;
  readonly conceptName: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
  readonly priorStrategyTag?: string;
}

export const QUIZ_ITEM_TYPES = [
  "multiple_choice",
  "short_answer",
  "concept_linking",
] as const;

export type QuizItemType = (typeof QUIZ_ITEM_TYPES)[number];

export interface QuizGenerationInput {
  readonly courseId: string;
  readonly conceptIds: readonly string[];
  readonly count: number;
  readonly requiredItemTypes?: readonly QuizItemType[];
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface ShortAnswerGradingInput {
  readonly answer: string;
  readonly conceptIds: readonly string[];
  readonly question: string;
  readonly rubric: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface TutorAnswerInput {
  readonly question: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface EmbeddingInput {
  readonly texts: readonly string[];
}

export const TTS_SYNTHESIS_REQUEST_VERSION =
  "tts-synthesis-request-v1" as const;
export const AUDIO_PAYLOAD_VERSION = "audio-payload-v1" as const;
export const REFLO_NARRATOR_VOICE_PROFILE = "en-US/reflo-narrator-v1" as const;
export const TTS_ALLOWED_SAMPLE_RATES = [22_050, 24_000] as const;

export interface TextToSpeechInput {
  readonly contractVersion: typeof TTS_SYNTHESIS_REQUEST_VERSION;
  readonly deadlineAt: string;
  readonly generationReference: string;
  readonly locale: "en-US";
  readonly narration: string;
  readonly narrationScriptId: string;
  readonly operationId: string;
  readonly output: {
    readonly allowedSampleRates: typeof TTS_ALLOWED_SAMPLE_RATES;
    readonly channels: 1;
    readonly codec: "pcm_s16le";
    readonly container: "wav";
  };
  readonly scriptSha256: string;
  readonly sourceSpanIds: readonly string[];
  readonly speakingRate: number;
  readonly voiceProfileId: typeof REFLO_NARRATOR_VOICE_PROFILE;
}

export interface VideoGenerationInput {
  readonly conceptId: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
  readonly visualBrief: string;
}

export interface CurriculumStructureResult {
  readonly chapters: readonly {
    readonly concepts: readonly {
      readonly key: string;
      readonly name: string;
      readonly prerequisiteKeys: readonly string[];
      readonly sourceSpanIds: readonly string[];
    }[];
    readonly sourceSpanIds: readonly string[];
    readonly title: string;
  }[];
}

export interface LessonResult {
  readonly content: string;
  readonly sourceSpanIds: readonly string[];
  readonly strategyTag: string;
}

export interface AudioScriptResult {
  readonly script: string;
  readonly sourceSpanIds: readonly string[];
}

export interface QuizGenerationResult {
  readonly items: readonly {
    readonly conceptIds: readonly string[];
    readonly difficulty: 1 | 2 | 3 | 4 | 5;
    readonly itemType: QuizItemType;
    readonly keyedAnswer: string;
    readonly prompt: string;
    readonly responseOptions?: readonly string[];
    readonly rubric?: string;
    readonly sourceSpanIds: readonly string[];
  }[];
}

export interface ShortAnswerGradingResult {
  readonly evidence: readonly {
    readonly conceptId: string;
    readonly confidence: number;
    readonly rubricBand: string;
    readonly score: number;
  }[];
}

export type TutorAnswerResult =
  | {
      readonly content: string;
      readonly kind: "answer";
      readonly sourceSpanIds: readonly string[];
    }
  | {
      readonly kind: "not_found";
    };

export interface EmbeddingResult {
  readonly metadata: {
    readonly dimensions: 1024;
    readonly endpoint: string;
    readonly inputMode: "document" | "query";
    readonly providerIdentifier: string;
    readonly providerRequestId: string;
    readonly region: string;
  };
  readonly vectors: readonly (readonly number[])[];
}

export interface AudioPayloadResult {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly channels: 1;
  readonly codec: "pcm_s16le";
  readonly container: "wav";
  readonly contractVersion: typeof AUDIO_PAYLOAD_VERSION;
  readonly durationSeconds: number;
  readonly engine: string;
  readonly engineVersion: string;
  readonly headerValidated: true;
  readonly payloadSha256: string;
  readonly sampleRateHz: (typeof TTS_ALLOWED_SAMPLE_RATES)[number];
  readonly settingsVersion: string;
  readonly sourceSpanIds: readonly string[];
  readonly voiceArtifactVersion: string;
  readonly voiceId: string;
  readonly voiceProfileId: typeof REFLO_NARRATOR_VOICE_PROFILE;
}

export interface VideoAssetResult {
  readonly durationSeconds: number;
  readonly mimeType: string;
  readonly sourceSpanIds: readonly string[];
  readonly uri: string;
}

export interface ModelTaskInputMap {
  readonly "assessment.grade-short-answer.v1": ShortAnswerGradingInput;
  readonly "assessment.quiz.v1": QuizGenerationInput;
  readonly "curriculum.structure.v1": CurriculumStructureInput;
  readonly "embedding.document.v1": EmbeddingInput;
  readonly "embedding.query.v1": EmbeddingInput;
  readonly "lesson.audio-script.v1": LessonInput;
  readonly "lesson.reteach.v1": LessonInput;
  readonly "lesson.text.v1": LessonInput;
  readonly "media.tts.v1": TextToSpeechInput;
  readonly "media.video.v1": VideoGenerationInput;
  readonly "tutor.answer.v1": TutorAnswerInput;
}

export interface ModelTaskResultMap {
  readonly "assessment.grade-short-answer.v1": ShortAnswerGradingResult;
  readonly "assessment.quiz.v1": QuizGenerationResult;
  readonly "curriculum.structure.v1": CurriculumStructureResult;
  readonly "embedding.document.v1": EmbeddingResult;
  readonly "embedding.query.v1": EmbeddingResult;
  readonly "lesson.audio-script.v1": AudioScriptResult;
  readonly "lesson.reteach.v1": LessonResult;
  readonly "lesson.text.v1": LessonResult;
  readonly "media.tts.v1": AudioPayloadResult;
  readonly "media.video.v1": VideoAssetResult;
  readonly "tutor.answer.v1": TutorAnswerResult;
}

export type ModelTaskInput<Task extends ModelTaskId> = ModelTaskInputMap[Task];

export type ModelTaskResult<Task extends ModelTaskId> =
  ModelTaskResultMap[Task];

export function isModelTaskId(value: string): value is ModelTaskId {
  return (MODEL_TASK_IDS as readonly string[]).includes(value);
}
