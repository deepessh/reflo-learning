import { createHash } from "node:crypto";

import {
  EVALUATION_CONTRACT_VERSION,
  EVIDENCE_BUNDLE_VERSION,
  RELEASE_GATE_IDS,
  SCORER_VERSION,
  type DatasetManifest,
  type EvidenceBundle,
  type GateResult,
  type GateRun,
} from "./contracts.js";
import { scoreGate } from "./scoring.js";

const FORBIDDEN_KEY =
  /(^|_)(answer|contact|email|learner|passage|secret|token|uploaded_content)($|_)/i;
const EMAIL_LIKE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const SECRET_LIKE = /\b(?:bearer|apikey|password|secret)\b/i;

export function createEvidenceBundle(
  manifest: DatasetManifest,
  run: GateRun,
  gateResult: GateResult,
): EvidenceBundle {
  if (run.gateId !== gateResult.gateId) {
    throw new Error("gate_result_mismatch");
  }
  if (canonicalJson(scoreGate(manifest, run)) !== canonicalJson(gateResult)) {
    throw new Error("gate_result_not_deterministic");
  }
  const manifestDigest = sha256(canonicalJson(manifest));
  const unsigned = {
    completedAt: run.metadata.completedAt,
    contractVersion: EVALUATION_CONTRACT_VERSION,
    datasetId: manifest.datasetId,
    datasetVersion: manifest.datasetVersion,
    deployableArtifactDigest: run.metadata.deployableArtifactDigest,
    environment: run.metadata.environment,
    evidenceBundleVersion: EVIDENCE_BUNDLE_VERSION,
    gateId: run.gateId,
    infrastructureFingerprint: run.metadata.infrastructureFingerprint,
    manifestDigest,
    metadata: run.metadata,
    observations: run.observations,
    result: gateResult,
    scorerVersion: SCORER_VERSION,
    sourceCommit: run.metadata.sourceCommit,
    startedAt: run.metadata.startedAt,
  } as const;
  assertSanitized(unsigned);
  return {
    ...unsigned,
    bundleDigest: `sha256:${sha256(canonicalJson(unsigned))}`,
  };
}

export function verifyEvidenceBundle(bundle: EvidenceBundle): boolean {
  const { bundleDigest, ...unsigned } = bundle;
  try {
    assertSanitized(unsigned);
  } catch {
    return false;
  }
  return (
    validEvidenceEnvelope(bundle) &&
    bundleDigest === `sha256:${sha256(canonicalJson(unsigned))}`
  );
}

export function githubSafeSummary(bundle: EvidenceBundle): string {
  return [
    `${bundle.gateId}: ${bundle.result.status}`,
    `dataset=${bundle.datasetId}@${bundle.datasetVersion}`,
    `samples=${bundle.observations.length}`,
    `misses=${bundle.result.misses.length}`,
    `bundle=${bundle.bundleDigest}`,
  ].join(" ");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new Error("evidence_contains_non_json_value");
}

function validEvidenceEnvelope(bundle: EvidenceBundle): boolean {
  const digest = /^sha256:[a-f0-9]{64}$/;
  const commit = /^[a-f0-9]{40}$/;
  const startedAt = Date.parse(bundle.startedAt);
  const completedAt = Date.parse(bundle.completedAt);
  return (
    bundle.contractVersion === EVALUATION_CONTRACT_VERSION &&
    bundle.evidenceBundleVersion === EVIDENCE_BUNDLE_VERSION &&
    bundle.scorerVersion === SCORER_VERSION &&
    (RELEASE_GATE_IDS as readonly string[]).includes(bundle.gateId) &&
    bundle.result.gateId === bundle.gateId &&
    ["failed", "indeterminate", "passed"].includes(bundle.result.status) &&
    bundle.metadata.environment === bundle.environment &&
    bundle.metadata.deployableArtifactDigest ===
      bundle.deployableArtifactDigest &&
    bundle.metadata.infrastructureFingerprint ===
      bundle.infrastructureFingerprint &&
    bundle.metadata.sourceCommit === bundle.sourceCommit &&
    bundle.metadata.startedAt === bundle.startedAt &&
    bundle.metadata.completedAt === bundle.completedAt &&
    digest.test(bundle.bundleDigest) &&
    digest.test(bundle.deployableArtifactDigest) &&
    digest.test(bundle.infrastructureFingerprint) &&
    /^[a-f0-9]{64}$/.test(bundle.manifestDigest) &&
    commit.test(bundle.sourceCommit) &&
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    completedAt >= startedAt &&
    Array.isArray(bundle.observations) &&
    Array.isArray(bundle.result.misses) &&
    Array.isArray(bundle.result.reasons)
  );
}

function assertSanitized(value: unknown, key = "root"): void {
  if (FORBIDDEN_KEY.test(key)) {
    throw new Error(`forbidden_evidence_field:${key}`);
  }
  if (typeof value === "string") {
    if (
      value.length > 512 ||
      EMAIL_LIKE.test(value) ||
      SECRET_LIKE.test(value)
    ) {
      throw new Error(`unsafe_evidence_value:${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertSanitized(entry, key);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assertSanitized(childValue, childKey);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
