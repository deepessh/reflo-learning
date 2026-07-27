import type {
  ExamReadinessCalibrationDisclosure,
  ExamReadinessDisclosure,
  ReadinessIneligibilityReason,
} from "./contracts.js";

const FIXED_SCALE = 100_000n;
const EVIDENCE_COVERAGE_MINIMUM = 80_000n;
export const EXAM_READINESS_PROFILE_VERSION =
  "exam-readiness-profile-v1" as const;

export interface ExamReadinessCalibrationInput {
  readonly meanAbsoluteError: string;
  readonly representative: boolean;
  readonly sampleSize: number;
  readonly version: string;
}

export interface ExamReadinessMappingInput {
  readonly active: boolean;
  readonly conceptId: string;
  readonly eligibleOutcomeCount: number;
  readonly mappingWeight: string;
  readonly mastery: string | null;
  readonly knowledgeAlgorithmVersion: string | null;
}

export interface ExamReadinessObjectiveInput {
  readonly id: string;
  readonly mappings: readonly ExamReadinessMappingInput[];
  readonly weight: string;
}

export interface ExamReadinessProfileInput {
  readonly blueprint: {
    readonly id: string;
    readonly version: string;
    readonly objectives: readonly ExamReadinessObjectiveInput[];
  } | null;
  readonly calibration: ExamReadinessCalibrationInput | null;
  readonly courseConceptIds: readonly string[];
  readonly knowledgeAlgorithmVersion: string;
  readonly mappingSetVersion: string | null;
}

export function evaluateExamReadiness(
  input: ExamReadinessProfileInput,
): ExamReadinessDisclosure {
  const calibration = calibrationDisclosure(input.calibration);
  if (input.blueprint === null) {
    return unavailable({
      blueprintVersion: null,
      calibration,
      courseConceptCount: input.courseConceptIds.length,
      reasons: ["blueprint_missing"],
      targetBlueprintId: null,
    });
  }

  const allMappings = input.blueprint.objectives.flatMap(
    (objective) => objective.mappings,
  );
  const activeMappings = allMappings.filter((mapping) => mapping.active);
  const invalidatedConceptCount = distinctCount(
    allMappings
      .filter((mapping) => !mapping.active)
      .map((mapping) => mapping.conceptId),
  );
  const mappedConceptIds = new Set(
    activeMappings.map((mapping) => mapping.conceptId),
  );
  const unmappedConceptCount = distinctCount(
    input.courseConceptIds.filter(
      (conceptId) => !mappedConceptIds.has(conceptId),
    ),
  );
  const mappedConceptCount = mappedConceptIds.size;

  if (input.mappingSetVersion === null) {
    return unavailable({
      blueprintVersion: input.blueprint.version,
      calibration,
      courseConceptCount: input.courseConceptIds.length,
      invalidatedConceptCount,
      mappedConceptCount,
      objectiveCount: input.blueprint.objectives.length,
      reasons: ["reviewed_mappings_unavailable"],
      targetBlueprintId: input.blueprint.id,
      unmappedConceptCount,
    });
  }

  const objectiveEvaluations = input.blueprint.objectives.map((objective) => {
    const objectiveWeight = parseFixed(objective.weight, "objective weight");
    const active = objective.mappings.filter((mapping) => mapping.active);
    const activeWeight = active.reduce(
      (sum, mapping) =>
        sum + parseFixed(mapping.mappingWeight, "mapping weight"),
      0n,
    );
    const eligible = active.filter(
      (mapping) =>
        mapping.eligibleOutcomeCount >= 2 &&
        mapping.mastery !== null &&
        mapping.knowledgeAlgorithmVersion === input.knowledgeAlgorithmVersion,
    );
    const eligibleWeight = eligible.reduce(
      (sum, mapping) =>
        sum + parseFixed(mapping.mappingWeight, "mapping weight"),
      0n,
    );
    return {
      activeWeight,
      eligible,
      eligibleWeight,
      id: objective.id,
      mapped: active.length > 0 && activeWeight === FIXED_SCALE,
      objectiveWeight,
    };
  });

  const objectiveMappedCount = objectiveEvaluations.filter(
    (objective) => objective.mapped,
  ).length;
  const objectiveEvidenceCount = objectiveEvaluations.filter(
    (objective) =>
      objective.eligible.length > 0 && objective.eligibleWeight > 0n,
  ).length;
  const coverageNumerator = objectiveEvaluations.reduce(
    (sum, objective) =>
      sum + objective.objectiveWeight * objective.eligibleWeight,
    0n,
  );
  const evidenceCoverage = formatFixed(
    roundFraction(coverageNumerator, FIXED_SCALE),
  );
  const evidenceEligibleConceptCount = distinctCount(
    objectiveEvaluations.flatMap((objective) =>
      objective.eligible.map((mapping) => mapping.conceptId),
    ),
  );
  const reasons: ReadinessIneligibilityReason[] = [];
  if (
    objectiveEvaluations.length === 0 ||
    objectiveMappedCount !== objectiveEvaluations.length
  ) {
    reasons.push("objective_mapping_incomplete");
  }
  if (
    objectiveEvaluations.length === 0 ||
    objectiveEvidenceCount !== objectiveEvaluations.length
  ) {
    reasons.push("objective_evidence_missing");
  }
  if (coverageNumerator < EVIDENCE_COVERAGE_MINIMUM * FIXED_SCALE) {
    reasons.push("evidence_coverage_insufficient");
  }
  if (reasons.length > 0) {
    return {
      blueprintVersion: input.blueprint.version,
      calibration,
      evidenceCoverage,
      evidenceEligibleConceptCount,
      invalidatedConceptCount,
      mappedConceptCount,
      mappingSetVersion: input.mappingSetVersion,
      objectiveCount: objectiveEvaluations.length,
      objectiveEvidenceCount,
      objectiveMappedCount,
      profileVersion: EXAM_READINESS_PROFILE_VERSION,
      reasons,
      score: null,
      status: "unavailable",
      targetBlueprintId: input.blueprint.id,
      unmappedConceptCount,
    };
  }

  const readinessNumerator = objectiveEvaluations.reduce((sum, objective) => {
    const objectiveScoreNumerator = objective.eligible.reduce(
      (objectiveSum, mapping) =>
        objectiveSum +
        parseFixed(mapping.mappingWeight, "mapping weight") *
          parseFixed(mapping.mastery!, "mastery"),
      0n,
    );
    const objectiveScore = roundFraction(
      objectiveScoreNumerator,
      objective.eligibleWeight,
    );
    return sum + objective.objectiveWeight * objectiveScore;
  }, 0n);
  const score = formatFixed(roundFraction(readinessNumerator, FIXED_SCALE));
  const experimental = calibration.status !== "adequate";
  return {
    blueprintVersion: input.blueprint.version,
    calibration,
    evidenceCoverage,
    evidenceEligibleConceptCount,
    experimental,
    invalidatedConceptCount,
    label: experimental ? "Exam Readiness — Experimental" : "Exam Readiness",
    mappedConceptCount,
    mappingSetVersion: input.mappingSetVersion,
    objectiveCount: objectiveEvaluations.length,
    objectiveEvidenceCount,
    objectiveMappedCount,
    profileVersion: EXAM_READINESS_PROFILE_VERSION,
    reasons: [],
    score,
    status: "eligible",
    targetBlueprintId: input.blueprint.id,
    unmappedConceptCount,
  };
}

function unavailable({
  blueprintVersion,
  calibration,
  courseConceptCount,
  invalidatedConceptCount = 0,
  mappedConceptCount = 0,
  objectiveCount = 0,
  reasons,
  targetBlueprintId,
  unmappedConceptCount = courseConceptCount,
}: {
  readonly blueprintVersion: string | null;
  readonly calibration: ExamReadinessCalibrationDisclosure;
  readonly courseConceptCount: number;
  readonly invalidatedConceptCount?: number;
  readonly mappedConceptCount?: number;
  readonly objectiveCount?: number;
  readonly reasons: readonly ReadinessIneligibilityReason[];
  readonly targetBlueprintId: string | null;
  readonly unmappedConceptCount?: number;
}): ExamReadinessDisclosure {
  return {
    blueprintVersion,
    calibration,
    evidenceCoverage: "0.00000",
    evidenceEligibleConceptCount: 0,
    invalidatedConceptCount,
    mappedConceptCount,
    mappingSetVersion: null,
    objectiveCount,
    objectiveEvidenceCount: 0,
    objectiveMappedCount: 0,
    profileVersion: EXAM_READINESS_PROFILE_VERSION,
    reasons,
    score: null,
    status: "unavailable",
    targetBlueprintId,
    unmappedConceptCount,
  };
}

function calibrationDisclosure(
  calibration: ExamReadinessCalibrationInput | null,
): ExamReadinessCalibrationDisclosure {
  if (calibration === null) {
    return {
      meanAbsoluteError: null,
      sampleSize: null,
      status: "unavailable",
      version: null,
    };
  }
  return {
    meanAbsoluteError: calibration.meanAbsoluteError,
    sampleSize: calibration.sampleSize,
    status:
      calibration.representative &&
      calibration.sampleSize >= 100 &&
      parseFixed(calibration.meanAbsoluteError, "mean absolute error") <=
        10_000n
        ? "adequate"
        : "inadequate",
    version: calibration.version,
  };
}

function parseFixed(value: string, label: string): bigint {
  const match = /^(0|1)\.(\d{5})$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid fixed-point ${label}`);
  }
  return BigInt(match[1]!) * FIXED_SCALE + BigInt(match[2]!);
}

function formatFixed(value: bigint): string {
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, -5)}.${digits.slice(-5)}`;
}

function roundFraction(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Readiness denominator must be positive");
  }
  let quotient = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) {
    quotient += 1n;
  }
  return quotient;
}

function distinctCount(values: readonly string[]): number {
  return new Set(values).size;
}
