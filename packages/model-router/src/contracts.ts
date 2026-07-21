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

export interface QuizGenerationInput {
  readonly courseId: string;
  readonly conceptIds: readonly string[];
  readonly count: number;
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

export interface TextToSpeechInput {
  readonly narration: string;
  readonly sourceSpanIds: readonly string[];
  readonly voice: string;
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
    readonly keyedAnswer: string;
    readonly prompt: string;
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

export interface AudioAssetResult {
  readonly durationSeconds: number;
  readonly mimeType: string;
  readonly sourceSpanIds: readonly string[];
  readonly uri: string;
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
  readonly "media.tts.v1": AudioAssetResult;
  readonly "media.video.v1": VideoAssetResult;
  readonly "tutor.answer.v1": TutorAnswerResult;
}

export type ModelTaskInput<Task extends ModelTaskId> = ModelTaskInputMap[Task];

export type ModelTaskResult<Task extends ModelTaskId> =
  ModelTaskResultMap[Task];

export function isModelTaskId(value: string): value is ModelTaskId {
  return (MODEL_TASK_IDS as readonly string[]).includes(value);
}
