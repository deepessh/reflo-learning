import { describe, expect, it } from "vitest";

import { evaluateExamReadiness } from "./readiness.js";

const blueprint = {
  id: "blueprint-v1",
  objectives: [
    {
      id: "objective-a",
      mappings: [
        mapping("concept-a", "0.80000", "0.75000", 2),
        mapping("concept-b", "0.20000", "0.25000", 2),
      ],
      weight: "0.60000",
    },
    {
      id: "objective-b",
      mappings: [
        mapping("concept-c", "0.50000", "0.50000", 2),
        mapping("concept-d", "0.50000", "0.90000", 1),
      ],
      weight: "0.40000",
    },
  ],
  version: "blueprint-v1",
} as const;

describe("exam-readiness-profile-v1", () => {
  it("admits exact 0.80 coverage and renormalizes within each objective", () => {
    const result = evaluateExamReadiness({
      blueprint,
      calibration: null,
      courseConceptIds: [
        "concept-a",
        "concept-b",
        "concept-c",
        "concept-d",
        "concept-unmapped",
      ],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });

    expect(result).toMatchObject({
      calibration: {
        meanAbsoluteError: null,
        sampleSize: null,
        status: "unavailable",
      },
      evidenceCoverage: "0.80000",
      evidenceEligibleConceptCount: 3,
      experimental: true,
      label: "Exam Readiness — Experimental",
      mappedConceptCount: 4,
      objectiveEvidenceCount: 2,
      objectiveMappedCount: 2,
      reasons: [],
      score: "0.59000",
      status: "eligible",
      unmappedConceptCount: 1,
    });
  });

  it("fails just below 0.80 and when an objective has no evidence", () => {
    const result = evaluateExamReadiness({
      blueprint: {
        ...blueprint,
        objectives: [
          blueprint.objectives[0],
          {
            ...blueprint.objectives[1],
            mappings: [
              mapping("concept-c", "0.49997", "0.50000", 2),
              mapping("concept-d", "0.50003", "0.90000", 1),
            ],
          },
        ],
      },
      calibration: null,
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(result).toMatchObject({
      evidenceCoverage: "0.79999",
      reasons: ["evidence_coverage_insufficient"],
      score: null,
      status: "unavailable",
    });

    const missingObjective = evaluateExamReadiness({
      blueprint: {
        ...blueprint,
        objectives: [
          blueprint.objectives[0],
          {
            ...blueprint.objectives[1],
            mappings: blueprint.objectives[1].mappings.map((candidate) => ({
              ...candidate,
              eligibleOutcomeCount: 1,
            })),
          },
        ],
      },
      calibration: null,
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(missingObjective.reasons).toContain("objective_evidence_missing");
  });

  it("invalidates replaced generations and never uses an unassessed prior", () => {
    const result = evaluateExamReadiness({
      blueprint: {
        ...blueprint,
        objectives: [
          {
            ...blueprint.objectives[0],
            mappings: [
              { ...blueprint.objectives[0].mappings[0], active: false },
              blueprint.objectives[0].mappings[1],
            ],
          },
          blueprint.objectives[1],
        ],
      },
      calibration: null,
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(result).toMatchObject({
      invalidatedConceptCount: 1,
      reasons: [
        "objective_mapping_incomplete",
        "evidence_coverage_insufficient",
      ],
      score: null,
    });

    const unassessed = evaluateExamReadiness({
      blueprint: {
        ...blueprint,
        objectives: blueprint.objectives.map((objective) => ({
          ...objective,
          mappings: objective.mappings.map((candidate) => ({
            ...candidate,
            eligibleOutcomeCount: 0,
            mastery: "0.25000",
          })),
        })),
      },
      calibration: null,
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(unassessed).toMatchObject({
      evidenceCoverage: "0.00000",
      evidenceEligibleConceptCount: 0,
      score: null,
    });
  });

  it("removes Experimental only for adequate frozen calibration evidence", () => {
    const inadequate = evaluateExamReadiness({
      blueprint,
      calibration: {
        meanAbsoluteError: "0.10000",
        representative: true,
        sampleSize: 99,
        version: "calibration-v1",
      },
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(inadequate).toMatchObject({
      calibration: { sampleSize: 99, status: "inadequate" },
      experimental: true,
    });

    const adequate = evaluateExamReadiness({
      blueprint,
      calibration: {
        meanAbsoluteError: "0.10000",
        representative: true,
        sampleSize: 100,
        version: "calibration-v2",
      },
      courseConceptIds: ["concept-a", "concept-b", "concept-c", "concept-d"],
      knowledgeAlgorithmVersion: "knowledge-model-v1",
      mappingSetVersion: "mapping-v1",
    });
    expect(adequate).toMatchObject({
      calibration: { sampleSize: 100, status: "adequate" },
      experimental: false,
      label: "Exam Readiness",
    });
  });
});

function mapping(
  conceptId: string,
  mappingWeight: string,
  mastery: string,
  eligibleOutcomeCount: number,
) {
  return {
    active: true,
    conceptId,
    eligibleOutcomeCount,
    knowledgeAlgorithmVersion: "knowledge-model-v1",
    mappingWeight,
    mastery,
  } as const;
}
