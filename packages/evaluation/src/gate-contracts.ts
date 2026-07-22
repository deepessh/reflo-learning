import type { ReleaseGateId } from "./contracts.js";

export interface GateContractDefinition {
  readonly allowedExecutionBoundaries: readonly (
    "production-equivalent" | "target-production"
  )[];
  readonly gateId: ReleaseGateId;
  readonly minimumItems: number;
  readonly minimumRepetitions: number;
  readonly requiredConcurrency: number;
  readonly requiredDependencyKeys: readonly string[];
  readonly requiredMutableEvidenceKinds: readonly string[];
  readonly requiredStrata: readonly string[];
}

export const GATE_CONTRACTS: Readonly<
  Record<ReleaseGateId, GateContractDefinition>
> = Object.freeze({
  "week1.adversarial": contract({
    allowedExecutionBoundaries: ["production-equivalent", "target-production"],
    gateId: "week1.adversarial",
    minimumItems: 20,
    minimumRepetitions: 1,
    requiredDependencyKeys: [
      "authorization-policy",
      "citation-renderer",
      "grading-policy",
      "model-router",
      "retrieval-policy",
      "tool-policy",
    ],
    requiredMutableEvidenceKinds: ["rights", "privacy"],
    requiredStrata: [
      "threat:cross-scope-reference",
      "threat:fake-citation",
      "threat:grading-manipulation",
      "threat:indirect-prompt-injection",
      "threat:tool-use-request",
    ],
  }),
  "week1.audio": contract({
    allowedExecutionBoundaries: ["target-production"],
    gateId: "week1.audio",
    minimumItems: 30,
    minimumRepetitions: 1,
    requiredDependencyKeys: [
      "audio-asset-contract",
      "piper-adapter",
      "piper-image",
      "qwen-adapter",
      "qwen-model",
      "route-policy",
    ],
    requiredMutableEvidenceKinds: ["capacity", "legal", "quota", "rights"],
    requiredStrata: ["script:representative"],
  }),
  "week1.performance": contract({
    allowedExecutionBoundaries: ["target-production"],
    gateId: "week1.performance",
    minimumItems: 40,
    minimumRepetitions: 3,
    requiredDependencyKeys: [
      "activation-contract",
      "audio-route",
      "curriculum-prompt",
      "embedding-profile",
      "ingestion-worker",
      "model-route-policy",
      "schema",
    ],
    requiredMutableEvidenceKinds: ["capacity", "quota", "rights"],
    requiredStrata: [
      "format:docx",
      "format:epub",
      "format:pdf",
      "pages:5-49",
      "pages:50-149",
      "pages:150-200",
      "size:0.5-4.9mb",
      "size:5-14.9mb",
      "size:15-20mb",
      "content:images",
      "content:tables",
      "structure:complex",
      "structure:simple",
    ],
  }),
  "week1.upload-security": contract({
    allowedExecutionBoundaries: ["production-equivalent", "target-production"],
    gateId: "week1.upload-security",
    minimumItems: 13,
    minimumRepetitions: 1,
    requiredDependencyKeys: [
      "authorization-policy",
      "ingestion-worker",
      "parser-policy",
      "scanner-snapshot",
    ],
    requiredMutableEvidenceKinds: ["rights"],
    requiredStrata: [
      "format:docx",
      "format:epub",
      "format:pdf",
      "route:encrypted",
      "route:malformed",
      "route:mixed",
      "route:over-limit",
      "route:scanned",
      "route:unsupported",
      "security:archive-bomb",
      "security:cross-scope",
      "security:networkless",
      "security:no-ambient-credentials",
    ],
  }),
});

function contract(
  definition: Omit<
    GateContractDefinition,
    "minimumRepetitions" | "requiredConcurrency"
  > &
    Partial<
      Pick<GateContractDefinition, "minimumRepetitions" | "requiredConcurrency">
    >,
): GateContractDefinition {
  return Object.freeze({
    ...definition,
    minimumRepetitions: definition.minimumRepetitions ?? 1,
    requiredConcurrency: definition.requiredConcurrency ?? 5,
  });
}
