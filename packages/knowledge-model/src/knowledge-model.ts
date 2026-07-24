import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  KnowledgeModelError,
  PRIOR_ALPHA_QUANTA,
  PRIOR_BETA_QUANTA,
  SCORE_QUANTA,
  type ExactKnowledgeState,
  type PerConceptEvidence,
} from "./contracts.js";

interface ValidatedEvidence {
  readonly evidence: PerConceptEvidence;
  readonly occurredAtMs: number;
  readonly scoreQuanta: bigint | null;
}

export function replayKnowledgeState(
  evidence: readonly PerConceptEvidence[],
): ExactKnowledgeState {
  const canonical = canonicalizeEvidence(evidence);
  let alphaQuanta = PRIOR_ALPHA_QUANTA;
  let betaQuanta = PRIOR_BETA_QUANTA;
  let evidenceCount = 0;
  let lastReviewedAt: string | null = null;

  for (const item of canonical) {
    if (!item.evidence.eligibleForMastery) {
      continue;
    }
    const scoreQuanta = item.scoreQuanta;
    if (scoreQuanta === null) {
      throw new KnowledgeModelError("invalid_evidence");
    }
    alphaQuanta += scoreQuanta;
    betaQuanta += SCORE_QUANTA - scoreQuanta;
    evidenceCount += 1;
    lastReviewedAt = new Date(item.occurredAtMs).toISOString();
  }

  return projectState(alphaQuanta, betaQuanta, evidenceCount, lastReviewedAt);
}

export function canonicalizeEvidence(
  evidence: readonly PerConceptEvidence[],
): readonly ValidatedEvidence[] {
  const unique = new Map<string, ValidatedEvidence>();

  for (const candidate of evidence) {
    const validated = validateEvidence(candidate);
    const identity = evidenceIdentity(candidate);
    const previous = unique.get(identity);
    if (previous === undefined) {
      unique.set(identity, validated);
      continue;
    }
    if (!sameEvidence(previous, validated)) {
      throw new KnowledgeModelError("conflicting_duplicate");
    }
  }

  return [...unique.values()].sort(compareEvidence);
}

export function evidenceIdentity(evidence: PerConceptEvidence): string {
  return [evidence.ownerScopeId, evidence.attemptId, evidence.conceptId].join(
    "/",
  );
}

function validateEvidence(evidence: PerConceptEvidence): ValidatedEvidence {
  if (
    evidence.knowledgeAlgorithmVersion !== KNOWLEDGE_ALGORITHM_VERSION ||
    evidence.knowledgeConfigurationId !== KNOWLEDGE_CONFIGURATION_ID
  ) {
    throw new KnowledgeModelError("unsupported_algorithm");
  }
  if (
    evidence.ownerScopeId.length === 0 ||
    evidence.userId.length === 0 ||
    evidence.attemptId.length === 0 ||
    evidence.conceptId.length === 0
  ) {
    throw new KnowledgeModelError("invalid_evidence");
  }
  const occurredAtMs = Date.parse(evidence.attemptCreatedAt);
  if (!Number.isFinite(occurredAtMs)) {
    throw new KnowledgeModelError("invalid_timestamp");
  }
  const scoreQuanta =
    evidence.score === null ? null : parseScoreQuanta(evidence.score);
  if (evidence.eligibleForMastery && scoreQuanta === null) {
    throw new KnowledgeModelError("invalid_evidence");
  }
  return { evidence, occurredAtMs, scoreQuanta };
}

function parseScoreQuanta(score: string): bigint {
  if (!/^(?:0(?:\.\d{1,5})?|1(?:\.0{1,5})?)$/.test(score)) {
    throw new KnowledgeModelError("invalid_score");
  }
  const [whole = "0", fraction = ""] = score.split(".");
  return BigInt(whole) * SCORE_QUANTA + BigInt(fraction.padEnd(5, "0"));
}

function sameEvidence(
  left: ValidatedEvidence,
  right: ValidatedEvidence,
): boolean {
  return (
    left.occurredAtMs === right.occurredAtMs &&
    left.scoreQuanta === right.scoreQuanta &&
    left.evidence.userId === right.evidence.userId &&
    left.evidence.eligibleForMastery === right.evidence.eligibleForMastery &&
    left.evidence.knowledgeAlgorithmVersion ===
      right.evidence.knowledgeAlgorithmVersion &&
    left.evidence.knowledgeConfigurationId ===
      right.evidence.knowledgeConfigurationId
  );
}

function compareEvidence(
  left: ValidatedEvidence,
  right: ValidatedEvidence,
): number {
  return (
    left.occurredAtMs - right.occurredAtMs ||
    compareAscii(left.evidence.attemptId, right.evidence.attemptId) ||
    compareAscii(left.evidence.conceptId, right.evidence.conceptId)
  );
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectState(
  alphaQuanta: bigint,
  betaQuanta: bigint,
  evidenceCount: number,
  lastReviewedAt: string | null,
): ExactKnowledgeState {
  const posteriorQuanta = alphaQuanta + betaQuanta;
  return {
    algorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    alphaQuanta: alphaQuanta.toString(),
    assessmentStatus: evidenceCount === 0 ? "unassessed" : "assessed",
    betaQuanta: betaQuanta.toString(),
    confidence: roundRatio(evidenceCount, evidenceCount + 4),
    configurationId: KNOWLEDGE_CONFIGURATION_ID,
    evidenceCount,
    lastReviewedAt,
    mastery: roundRatio(alphaQuanta, posteriorQuanta),
  };
}

function roundRatio(
  numerator: bigint | number,
  denominator: bigint | number,
): string {
  const exactNumerator = BigInt(numerator);
  const exactDenominator = BigInt(denominator);
  const scaledNumerator = exactNumerator * SCORE_QUANTA;
  let rounded = scaledNumerator / exactDenominator;
  const remainder = scaledNumerator % exactDenominator;
  if (remainder * 2n >= exactDenominator) {
    rounded += 1n;
  }
  const digits = rounded.toString().padStart(6, "0");
  return `${digits.slice(0, -5)}.${digits.slice(-5)}`;
}
