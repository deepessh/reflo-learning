import type {
  CurriculumSegmentInput,
  CurriculumSegmentResult,
  ModelCallProvenance,
} from "@reflo/model-router";

import {
  CURRICULUM_COMPOSITION_VERSION,
  CURRICULUM_PARTITION_VERSION,
  CURRICULUM_SEGMENT_GENERATION_VERSION,
  CURRICULUM_SEGMENT_MAX_SOURCE_TOKENS,
  CURRICULUM_SEGMENT_MAX_SPANS,
  CURRICULUM_SEGMENT_TASK_VERSION,
  TOKENIZER_VERSION,
  type AuthorizedSourceAccess,
  type ComposedCurriculumResult,
  type CurriculumPartitionManifest,
  type CurriculumSegmentManifestEntry,
  type PersistedCurriculumSegmentResult,
  type SourceSpanRecord,
} from "./contracts.js";
import { RetrievalError } from "./errors.js";
import { canonicalJson, sha256, stableUuid } from "./identity.js";
import { unicodeTokenizerV1 } from "./tokenizer.js";

interface MutableSegment {
  readonly sectionPath: readonly string[] | null;
  readonly spans: SourceSpanRecord[];
  sourceTokenCount: number;
}

interface MutableChapter {
  readonly contributions: {
    readonly localChapterIndex: number;
    readonly segmentId: string;
  }[];
  readonly concepts: MutableConcept[];
  readonly normalizedTitle: string;
  readonly sourceSpanIds: Set<string>;
  readonly title: string;
}

interface MutableConcept {
  readonly contributions: {
    readonly localKey: string;
    readonly segmentId: string;
  }[];
  readonly localKey: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly prerequisites: Set<MutableConcept>;
  readonly sourceSpanIds: Set<string>;
}

export function partitionCurriculumSource(
  access: AuthorizedSourceAccess,
  embeddingGenerationId: string,
  spans: readonly SourceSpanRecord[],
): CurriculumPartitionManifest {
  validatePartitionInput(access, embeddingGenerationId, spans);
  const parentGenerationId = stableUuid({
    compositionVersion: CURRICULUM_COMPOSITION_VERSION,
    courseId: access.courseId,
    embeddingGenerationId,
    generationVersion: CURRICULUM_SEGMENT_GENERATION_VERSION,
    ownerScopeId: access.ownerScopeId,
    partitionVersion: CURRICULUM_PARTITION_VERSION,
    sourceDocumentId: access.sourceDocumentId,
    spans: spans.map((span) => ({
      chunkOrder: span.chunkOrder,
      embeddingInputHash: span.embeddingInputHash,
      id: span.id,
      sectionPath: span.sectionPath,
    })),
    tokenizerVersion: TOKENIZER_VERSION,
  });
  const groups: MutableSegment[] = [];
  for (const span of spans) {
    const sourceTokenCount = unicodeTokenizerV1.count(span.canonicalText);
    if (sourceTokenCount > CURRICULUM_SEGMENT_MAX_SOURCE_TOKENS) {
      throw new RetrievalError(
        "invalid_chunk",
        "one source span exceeds the curriculum segment token ceiling",
      );
    }
    const sectionPath = span.sectionPath.length === 0 ? null : span.sectionPath;
    const current = groups.at(-1);
    if (
      current === undefined ||
      !sameSectionPath(current.sectionPath, sectionPath) ||
      current.spans.length >= CURRICULUM_SEGMENT_MAX_SPANS ||
      current.sourceTokenCount + sourceTokenCount >
        CURRICULUM_SEGMENT_MAX_SOURCE_TOKENS
    ) {
      groups.push({
        sectionPath: sectionPath === null ? null : [...sectionPath],
        sourceTokenCount,
        spans: [span],
      });
      continue;
    }
    current.spans.push(span);
    current.sourceTokenCount += sourceTokenCount;
  }
  const segments = groups.map((group, ordinal) =>
    segmentManifestEntry(
      access.courseTitle,
      parentGenerationId,
      ordinal,
      group,
    ),
  );
  const manifestWithoutHash = {
    compositionVersion: CURRICULUM_COMPOSITION_VERSION,
    courseId: access.courseId,
    embeddingGenerationId,
    generationVersion: CURRICULUM_SEGMENT_GENERATION_VERSION,
    ownerScopeId: access.ownerScopeId,
    parentGenerationId,
    partitionVersion: CURRICULUM_PARTITION_VERSION,
    segments,
    sourceDocumentId: access.sourceDocumentId,
    tokenizerVersion: TOKENIZER_VERSION,
  } as const;
  return {
    ...manifestWithoutHash,
    manifestHash: sha256(canonicalJson(manifestWithoutHash)),
  };
}

export function curriculumSegmentInput(
  courseTitle: string,
  segment: CurriculumSegmentManifestEntry,
  spans: readonly SourceSpanRecord[],
): CurriculumSegmentInput {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const selected = segment.sourceSpanIds.map((id) => {
    const span = byId.get(id);
    if (
      span === undefined ||
      span.embeddingInputHash !==
        segment.sourceSpanInputHashes[selectedIndex(segment.sourceSpanIds, id)]
    ) {
      throw new RetrievalError(
        "invalid_chunk",
        "curriculum segment source identity changed",
      );
    }
    return {
      id: span.id,
      inputHash: span.embeddingInputHash,
      sourceOrder: span.chunkOrder,
      text: span.canonicalText,
    };
  });
  const input = {
    courseTitle,
    sectionPath: segment.sectionPath,
    segmentId: segment.id,
    segmentOrdinal: segment.ordinal,
    sourceOrderEnd: segment.lastSourceOrder,
    sourceOrderStart: segment.firstSourceOrder,
    sourceSpans: selected,
  };
  if (sha256(canonicalJson(input)) !== segment.inputHash) {
    throw new RetrievalError(
      "invalid_chunk",
      "curriculum segment input hash changed",
    );
  }
  return input;
}

export function composeCurriculum(
  manifest: CurriculumPartitionManifest,
  courseTitle: string,
  spans: readonly SourceSpanRecord[],
  persistedResults: readonly PersistedCurriculumSegmentResult[],
): {
  readonly modelProvenance: readonly ModelCallProvenance[];
  readonly result: ComposedCurriculumResult;
} {
  validateManifest(manifest, courseTitle, spans);
  const resultBySegment = new Map(
    persistedResults.map((result) => [result.segmentId, result]),
  );
  if (
    resultBySegment.size !== manifest.segments.length ||
    persistedResults.length !== manifest.segments.length
  ) {
    throw new RetrievalError(
      "invalid_model_result",
      "curriculum composition requires one result for every segment",
    );
  }
  const sourceOrder = new Map(spans.map((span) => [span.id, span.chunkOrder]));
  const chapters: MutableChapter[] = [];
  let instructionalCount = 0;

  for (const segment of manifest.segments) {
    const persisted = resultBySegment.get(segment.id);
    if (
      persisted === undefined ||
      persisted.inputHash !== segment.inputHash ||
      persisted.resultHash !== sha256(canonicalJson(persisted.result))
    ) {
      throw new RetrievalError(
        "invalid_model_result",
        "curriculum child result identity is inconsistent",
      );
    }
    validateChildResult(segment, persisted.result);
    if (persisted.result.kind === "non_instructional") {
      continue;
    }
    instructionalCount += 1;
    composeInstructionalResult(
      chapters,
      segment,
      persisted.result,
      sourceOrder,
    );
  }
  if (instructionalCount === 0 || chapters.length === 0) {
    throw new RetrievalError(
      "invalid_model_result",
      "curriculum has no instructional result",
    );
  }

  const conceptIdentities = new Map<
    MutableConcept,
    { id: string; key: string }
  >();
  for (const chapter of chapters) {
    for (const concept of chapter.concepts) {
      const orderedSourceSpanIds = orderSpanIds(
        concept.sourceSpanIds,
        sourceOrder,
      );
      const id = stableUuid({
        compositionVersion: CURRICULUM_COMPOSITION_VERSION,
        contributions: concept.contributions,
        normalizedName: concept.normalizedName,
        parentGenerationId: manifest.parentGenerationId,
        sourceSpanIds: orderedSourceSpanIds,
      });
      conceptIdentities.set(concept, {
        id,
        key: `c_${id.replaceAll("-", "")}`,
      });
    }
  }
  const composedChapters = chapters.map((chapter) => {
    const orderedChapterSpanIds = orderSpanIds(
      chapter.sourceSpanIds,
      sourceOrder,
    );
    const chapterId = stableUuid({
      compositionVersion: CURRICULUM_COMPOSITION_VERSION,
      contributions: chapter.contributions,
      normalizedTitle: chapter.normalizedTitle,
      parentGenerationId: manifest.parentGenerationId,
      sourceSpanIds: orderedChapterSpanIds,
    });
    return {
      concepts: chapter.concepts.map((concept) => {
        const identity = required(
          conceptIdentities.get(concept),
          "missing composed concept identity",
        );
        return {
          id: identity.id,
          key: identity.key,
          name: concept.name,
          prerequisiteKeys: [...concept.prerequisites].map(
            (prerequisite) =>
              required(
                conceptIdentities.get(prerequisite),
                "missing composed prerequisite identity",
              ).key,
          ),
          sourceSpanIds: orderSpanIds(concept.sourceSpanIds, sourceOrder),
        };
      }),
      id: chapterId,
      sourceSpanIds: orderedChapterSpanIds,
      title: chapter.title,
    };
  });
  const orderedResults = manifest.segments.map((segment) =>
    required(
      resultBySegment.get(segment.id),
      "missing ordered curriculum result",
    ),
  );
  return {
    modelProvenance: orderedResults.map((result) => result.modelProvenance),
    result: {
      chapters: composedChapters,
      childResultHashes: orderedResults.map((result) => result.resultHash),
      compositionVersion: CURRICULUM_COMPOSITION_VERSION,
      embeddingGenerationId: manifest.embeddingGenerationId,
      generationVersion: CURRICULUM_SEGMENT_GENERATION_VERSION,
      partitionManifestHash: manifest.manifestHash,
    },
  };
}

function validatePartitionInput(
  access: AuthorizedSourceAccess,
  embeddingGenerationId: string,
  spans: readonly SourceSpanRecord[],
): void {
  if (embeddingGenerationId.length === 0 || spans.length === 0) {
    throw new RetrievalError("invalid_chunk", "curriculum source is empty");
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const [index, span] of spans.entries()) {
    if (
      span.ownerScopeId !== access.ownerScopeId ||
      span.sourceDocumentId !== access.sourceDocumentId
    ) {
      throw new RetrievalError("authorization_denied");
    }
    if (
      span.contractVersion !== "source-span-v1" ||
      span.chunkerVersion !== "chunk-v1" ||
      span.tokenizerVersion !== TOKENIZER_VERSION ||
      span.chunkOrder !== index ||
      ids.has(span.id) ||
      orders.has(span.chunkOrder) ||
      !/^[a-f0-9]{64}$/.test(span.embeddingInputHash)
    ) {
      throw new RetrievalError(
        "invalid_chunk",
        "curriculum source span sequence is inconsistent",
      );
    }
    ids.add(span.id);
    orders.add(span.chunkOrder);
  }
}

function segmentManifestEntry(
  courseTitle: string,
  parentGenerationId: string,
  ordinal: number,
  group: MutableSegment,
): CurriculumSegmentManifestEntry {
  const first = required(group.spans[0], "missing segment first span");
  const last = required(group.spans.at(-1), "missing segment last span");
  const immutableInput = {
    firstSourceOrder: first.chunkOrder,
    lastSourceOrder: last.chunkOrder,
    ordinal,
    parentGenerationId,
    partitionVersion: CURRICULUM_PARTITION_VERSION,
    sectionPath: group.sectionPath,
    sourceSpanIds: group.spans.map((span) => span.id),
    sourceSpanInputHashes: group.spans.map((span) => span.embeddingInputHash),
    sourceTokenCount: group.sourceTokenCount,
    taskVersion: CURRICULUM_SEGMENT_TASK_VERSION,
  } as const;
  const id = stableUuid(immutableInput);
  const entryWithoutInputHash = {
    ...immutableInput,
    id,
  };
  return {
    ...entryWithoutInputHash,
    inputHash: sha256(
      canonicalJson({
        courseTitle,
        sectionPath: group.sectionPath,
        segmentId: id,
        segmentOrdinal: ordinal,
        sourceOrderEnd: last.chunkOrder,
        sourceOrderStart: first.chunkOrder,
        sourceSpans: group.spans.map((span) => ({
          id: span.id,
          inputHash: span.embeddingInputHash,
          sourceOrder: span.chunkOrder,
          text: span.canonicalText,
        })),
      }),
    ),
  };
}

function validateManifest(
  manifest: CurriculumPartitionManifest,
  courseTitle: string,
  spans: readonly SourceSpanRecord[],
): void {
  if (
    manifest.partitionVersion !== CURRICULUM_PARTITION_VERSION ||
    manifest.compositionVersion !== CURRICULUM_COMPOSITION_VERSION ||
    manifest.generationVersion !== CURRICULUM_SEGMENT_GENERATION_VERSION ||
    manifest.tokenizerVersion !== TOKENIZER_VERSION ||
    manifest.segments.length === 0
  ) {
    throw new RetrievalError("invalid_configuration");
  }
  const reconstructed = partitionCurriculumSource(
    {
      actorId: "composition-replay",
      authorizationId: "composition-replay",
      courseId: manifest.courseId,
      courseTitle,
      ownerScopeId: manifest.ownerScopeId,
      sourceDocumentId: manifest.sourceDocumentId,
    },
    manifest.embeddingGenerationId,
    spans,
  );
  if (
    reconstructed.parentGenerationId !== manifest.parentGenerationId ||
    reconstructed.manifestHash !== manifest.manifestHash ||
    canonicalJson(reconstructed.segments) !== canonicalJson(manifest.segments)
  ) {
    throw new RetrievalError(
      "invalid_configuration",
      "curriculum partition replay changed",
    );
  }
}

function validateChildResult(
  segment: CurriculumSegmentManifestEntry,
  result: CurriculumSegmentResult,
): void {
  if (
    result.segmentId !== segment.id ||
    result.segmentOrdinal !== segment.ordinal
  ) {
    throw new RetrievalError("invalid_model_result");
  }
  const authorized = new Set(segment.sourceSpanIds);
  if (result.kind === "non_instructional") {
    if (
      result.sourceSpanIds.length !== segment.sourceSpanIds.length ||
      result.sourceSpanIds.some(
        (id, index) => id !== segment.sourceSpanIds[index],
      )
    ) {
      throw new RetrievalError("invalid_model_result");
    }
    return;
  }
  const seenKeys = new Set<string>();
  for (const chapter of result.chapters) {
    if (
      chapter.sourceSpanIds.length === 0 ||
      chapter.sourceSpanIds.some((id) => !authorized.has(id)) ||
      chapter.concepts.length === 0
    ) {
      throw new RetrievalError("invalid_model_result");
    }
    for (const concept of chapter.concepts) {
      if (
        seenKeys.has(concept.key) ||
        concept.sourceSpanIds.length === 0 ||
        concept.sourceSpanIds.some((id) => !authorized.has(id)) ||
        concept.prerequisiteKeys.some((key) => !seenKeys.has(key))
      ) {
        throw new RetrievalError("invalid_model_result");
      }
      seenKeys.add(concept.key);
    }
  }
}

function composeInstructionalResult(
  chapters: MutableChapter[],
  segment: CurriculumSegmentManifestEntry,
  result: Extract<CurriculumSegmentResult, { kind: "instructional" }>,
  sourceOrder: ReadonlyMap<string, number>,
): void {
  const localConcepts = new Map<string, MutableConcept>();
  for (const [localChapterIndex, localChapter] of result.chapters.entries()) {
    const normalizedTitle = normalize(localChapter.title);
    let chapter = chapters.at(-1);
    if (chapter === undefined || chapter.normalizedTitle !== normalizedTitle) {
      chapter = {
        concepts: [],
        contributions: [],
        normalizedTitle,
        sourceSpanIds: new Set<string>(),
        title: localChapter.title.trim(),
      };
      chapters.push(chapter);
    }
    chapter.contributions.push({
      localChapterIndex,
      segmentId: segment.id,
    });
    for (const id of localChapter.sourceSpanIds) {
      chapter.sourceSpanIds.add(id);
    }
    for (const localConcept of localChapter.concepts) {
      const normalizedName = normalize(localConcept.name);
      let concept = chapter.concepts.find(
        (candidate) =>
          candidate.localKey === localConcept.key &&
          candidate.normalizedName === normalizedName,
      );
      if (concept === undefined) {
        concept = {
          contributions: [],
          localKey: localConcept.key,
          name: localConcept.name.trim(),
          normalizedName,
          prerequisites: new Set<MutableConcept>(),
          sourceSpanIds: new Set<string>(),
        };
        chapter.concepts.push(concept);
      }
      concept.contributions.push({
        localKey: localConcept.key,
        segmentId: segment.id,
      });
      for (const id of localConcept.sourceSpanIds) {
        concept.sourceSpanIds.add(id);
        chapter.sourceSpanIds.add(id);
      }
      for (const prerequisiteKey of localConcept.prerequisiteKeys) {
        concept.prerequisites.add(
          required(
            localConcepts.get(prerequisiteKey),
            "missing local curriculum prerequisite",
          ),
        );
      }
      localConcepts.set(localConcept.key, concept);
    }
  }
  for (const chapter of chapters) {
    orderSpanIds(chapter.sourceSpanIds, sourceOrder);
  }
}

function orderSpanIds(
  ids: ReadonlySet<string>,
  sourceOrder: ReadonlyMap<string, number>,
): readonly string[] {
  return [...ids].sort(
    (left, right) =>
      required(sourceOrder.get(left), "missing source span order") -
      required(sourceOrder.get(right), "missing source span order"),
  );
}

function sameSectionPath(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((entry, index) => entry === right[index]))
  );
}

function normalize(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    throw new RetrievalError("invalid_model_result");
  }
  return normalized.toLocaleLowerCase("en-US");
}

function selectedIndex(ids: readonly string[], id: string): number {
  const index = ids.indexOf(id);
  if (index < 0) {
    throw new RetrievalError("invalid_chunk");
  }
  return index;
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new RetrievalError("invalid_model_result", message);
  }
  return value;
}
