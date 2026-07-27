import type {
  CurriculumSegmentResult,
  ModelCallProvenance,
} from "@reflo/model-router";
import { describe, expect, it } from "vitest";

import { chunkNormalizedDocument } from "./chunker.js";
import {
  composeCurriculum,
  curriculumSegmentInput,
  partitionCurriculumSource,
} from "./curriculum.js";
import { canonicalJson, sha256, stableUuid } from "./identity.js";
import type {
  CurriculumSegmentManifestEntry,
  PersistedCurriculumSegmentResult,
  SourceSpanRecord,
} from "./contracts.js";
import { normalizedDocument } from "@reflo/ingestion/testing";

const access = {
  actorId: "00000000-0000-4000-8000-000000000001",
  authorizationId: "request-auth-0001",
  courseId: "00000000-0000-4000-8000-000000000301",
  courseTitle: "Course",
  ownerScopeId: "00000000-0000-4000-8000-000000000101",
  sourceDocumentId: "00000000-0000-4000-8000-000000000201",
} as const;
const embeddingGenerationId = "00000000-0000-5000-8000-000000000501";
const [baseSpan] = chunkNormalizedDocument({
  document: normalizedDocument("pdf", "a".repeat(64)),
  ownerScopeId: access.ownerScopeId,
  sourceDocumentId: access.sourceDocumentId,
});
if (baseSpan === undefined) {
  throw new Error("source span fixture missing");
}

describe("curriculum-partition-v1", () => {
  it("partitions sectionless spans into stable complete twelve-span windows", () => {
    const spans = Array.from({ length: 25 }, (_, index) =>
      span(index, [], `source ${index}`),
    );

    const first = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );
    const replay = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );

    expect(first).toEqual(replay);
    expect(
      first.segments.map((segment) => segment.sourceSpanIds.length),
    ).toEqual([12, 12, 1]);
    expect(first.segments.flatMap((segment) => segment.sourceSpanIds)).toEqual(
      spans.map((entry) => entry.id),
    );
    expect(new Set(first.segments.map((segment) => segment.id))).toHaveLength(
      3,
    );
    for (const segment of first.segments) {
      expect(segment.sourceTokenCount).toBeLessThanOrEqual(8_000);
      expect(
        curriculumSegmentInput(access.courseTitle, segment, spans).sourceSpans,
      ).toHaveLength(segment.sourceSpanIds.length);
    }
  });

  it("preserves genuine section boundaries and splits oversized sections", () => {
    const spans = [
      ...Array.from({ length: 13 }, (_, index) =>
        span(index, ["Unit 1"], `unit one ${index}`),
      ),
      span(13, ["Unit 2"], "unit two"),
      span(14, [], "sectionless"),
    ];

    const manifest = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );

    expect(
      manifest.segments.map((segment) => ({
        count: segment.sourceSpanIds.length,
        path: segment.sectionPath,
      })),
    ).toEqual([
      { count: 12, path: ["Unit 1"] },
      { count: 1, path: ["Unit 1"] },
      { count: 1, path: ["Unit 2"] },
      { count: 1, path: null },
    ]);
  });

  it("fails closed for empty, discontinuous, mixed-owner, and oversized input", () => {
    const valid = span(0, [], "valid");
    for (const spans of [
      [],
      [valid, span(2, [], "gap")],
      [{ ...valid, ownerScopeId: stableUuid("foreign-owner") }],
      [span(0, [], "token ".repeat(8_001))],
    ]) {
      expect(() =>
        partitionCurriculumSource(
          access,
          embeddingGenerationId,
          spans as readonly SourceSpanRecord[],
        ),
      ).toThrow();
    }
  });
});

describe("curriculum-compose-v1", () => {
  it("is completion-order independent and exactly coalesces adjacent duplicates", () => {
    const spans = [span(0, ["One"], "first"), span(1, ["Two"], "second")];
    const manifest = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );
    const [firstSegment, secondSegment] = manifest.segments;
    if (firstSegment === undefined || secondSegment === undefined) {
      throw new Error("segment fixture missing");
    }
    const first = persisted(
      firstSegment,
      instructional(firstSegment, [
        {
          concepts: [
            {
              key: "intro",
              name: "Introduction",
              prerequisiteKeys: [],
              sourceSpanIds: [spans[0]!.id],
            },
            {
              key: "advanced",
              name: "Advanced",
              prerequisiteKeys: ["intro"],
              sourceSpanIds: [spans[0]!.id],
            },
          ],
          sourceSpanIds: [spans[0]!.id],
          title: "Basics",
        },
      ]),
    );
    const second = persisted(
      secondSegment,
      instructional(secondSegment, [
        {
          concepts: [
            {
              key: "intro",
              name: " Introduction ",
              prerequisiteKeys: [],
              sourceSpanIds: [spans[1]!.id],
            },
          ],
          sourceSpanIds: [spans[1]!.id],
          title: " basics ",
        },
      ]),
    );

    const ordered = composeCurriculum(manifest, access.courseTitle, spans, [
      first,
      second,
    ]);
    const shuffled = composeCurriculum(manifest, access.courseTitle, spans, [
      second,
      first,
    ]);

    expect(shuffled).toEqual(ordered);
    expect(ordered.result.chapters).toHaveLength(1);
    expect(ordered.result.chapters[0]?.concepts).toHaveLength(2);
    expect(ordered.result.chapters[0]?.concepts[0]?.sourceSpanIds).toEqual(
      spans.map((entry) => entry.id),
    );
    expect(ordered.result.chapters[0]?.concepts[1]?.prerequisiteKeys).toEqual([
      ordered.result.chapters[0]?.concepts[0]?.key,
    ]);
    expect(ordered.result.chapters[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
  });

  it("fails closed for missing, foreign, or wholly non-instructional children", () => {
    const spans = [span(0, [], "front matter")];
    const manifest = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );
    const segment = manifest.segments[0]!;
    const nonInstructional = persisted(segment, {
      kind: "non_instructional",
      reason: "front_matter",
      segmentId: segment.id,
      segmentOrdinal: segment.ordinal,
      sourceSpanIds: segment.sourceSpanIds,
    });

    expect(() =>
      composeCurriculum(manifest, access.courseTitle, spans, []),
    ).toThrow();
    expect(() =>
      composeCurriculum(manifest, access.courseTitle, spans, [
        { ...nonInstructional, inputHash: "0".repeat(64) },
      ]),
    ).toThrow();
    expect(() =>
      composeCurriculum(manifest, access.courseTitle, spans, [
        nonInstructional,
      ]),
    ).toThrow("no instructional result");
  });

  it("preserves local prerequisites across chapter boundaries", () => {
    const spans = [span(0, [], "instructional")];
    const manifest = partitionCurriculumSource(
      access,
      embeddingGenerationId,
      spans,
    );
    const segment = manifest.segments[0]!;
    const composed = composeCurriculum(manifest, access.courseTitle, spans, [
      persisted(
        segment,
        instructional(segment, [
          {
            concepts: [
              {
                key: "intro",
                name: "Introduction",
                prerequisiteKeys: [],
                sourceSpanIds: [spans[0]!.id],
              },
            ],
            sourceSpanIds: [spans[0]!.id],
            title: "Introduction",
          },
          {
            concepts: [
              {
                key: "advanced",
                name: "Advanced",
                prerequisiteKeys: ["intro"],
                sourceSpanIds: [spans[0]!.id],
              },
            ],
            sourceSpanIds: [spans[0]!.id],
            title: "Advanced",
          },
        ]),
      ),
    ]);

    expect(composed.result.chapters[1]?.concepts[0]?.prerequisiteKeys).toEqual([
      composed.result.chapters[0]?.concepts[0]?.key,
    ]);
  });
});

function span(
  chunkOrder: number,
  sectionPath: readonly string[],
  canonicalText: string,
): SourceSpanRecord {
  const embeddingInputHash = sha256(
    canonicalJson({ canonicalText, chunkOrder, sectionPath }),
  );
  return {
    ...baseSpan,
    canonicalEnd: chunkOrder * 10 + canonicalText.length,
    canonicalStart: chunkOrder * 10,
    canonicalText,
    chunkOrder,
    embeddingInput: canonicalText,
    embeddingInputHash,
    id: stableUuid({ chunkOrder, embeddingInputHash }),
    sectionPath,
    textHash: sha256(canonicalText),
  };
}

function instructional(
  segment: CurriculumSegmentManifestEntry,
  chapters: Extract<
    CurriculumSegmentResult,
    { kind: "instructional" }
  >["chapters"],
): CurriculumSegmentResult {
  return {
    chapters,
    kind: "instructional",
    segmentId: segment.id,
    segmentOrdinal: segment.ordinal,
  };
}

function persisted(
  segment: CurriculumSegmentManifestEntry,
  result: CurriculumSegmentResult,
): PersistedCurriculumSegmentResult {
  return {
    attemptCount: 1,
    inputHash: segment.inputHash,
    modelProvenance: provenance,
    result,
    resultHash: sha256(canonicalJson(result)),
    segmentId: segment.id,
  };
}

const provenance: ModelCallProvenance = {
  adapterVersion: "scripted-adapter-v1",
  evidenceClassification: "development_only",
  effectiveModel: "qwen-plus",
  effectiveModelVersion: "fixture-version-1",
  generationParametersVersion: "curriculum-segment-generation-parameters-v1",
  inputSchemaVersion: "curriculum-segment-input-v1",
  promptDefinitionDigest: "a".repeat(64),
  promptDigest: "b".repeat(64),
  promptId: "curriculum-segment",
  promptVersion: "1",
  requestedSelector: "qwen.structured",
  resultSchemaVersion: "curriculum-segment-result-v1",
  routePolicyVersion: "route-policy-v5",
  task: "curriculum.segment.v1",
  validationOutcome: "passed",
};
