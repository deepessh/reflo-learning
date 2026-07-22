import {
  DATASET_MANIFEST_VERSION,
  EVALUATION_CONTRACT_VERSION,
  RELEASE_GATE_IDS,
  type DatasetItem,
  type DatasetManifest,
  type GateRun,
  type ReleaseGateId,
} from "./contracts.js";
import { GATE_CONTRACTS } from "./gate-contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,127}$/;
const SAFE_REFERENCE = /^[a-z][a-z0-9+.-]*:[^\s]{3,300}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export function validateDatasetManifest(
  value: DatasetManifest,
): readonly string[] {
  const reasons: string[] = [];
  if (value.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    reasons.push("unknown_evaluation_contract");
  }
  if (value.manifestSchemaVersion !== DATASET_MANIFEST_VERSION) {
    reasons.push("unknown_manifest_schema");
  }
  if (
    !OPAQUE_ID.test(value.datasetId) ||
    !OPAQUE_ID.test(value.datasetVersion)
  ) {
    reasons.push("dataset_identity_invalid");
  }
  if (!value.heldOut) {
    reasons.push("dataset_not_held_out");
  }
  if (
    value.intendedGates.length === 0 ||
    new Set(value.intendedGates).size !== value.intendedGates.length ||
    value.intendedGates.some(
      (gate) => !(RELEASE_GATE_IDS as readonly string[]).includes(gate),
    )
  ) {
    reasons.push("intended_gates_invalid");
  }
  if (
    !nonEmpty(value.selection.method) ||
    (value.selection.seed !== null &&
      !Number.isSafeInteger(value.selection.seed))
  ) {
    reasons.push("selection_invalid");
  }
  if (Object.values(value.protocols).some((version) => !nonEmpty(version))) {
    reasons.push("protocol_versions_incomplete");
  }
  if (
    value.rightsApprovalReferences.length === 0 ||
    new Set(value.rightsApprovalReferences).size !==
      value.rightsApprovalReferences.length ||
    value.rightsApprovalReferences.some(
      (reference) => !safeReference(reference),
    )
  ) {
    reasons.push("rights_approval_missing_or_invalid");
  }

  const ids = new Set<string>();
  for (const item of value.items) {
    validateItem(item, ids, reasons);
    if (
      !value.rightsApprovalReferences.includes(item.rightsApprovalReference)
    ) {
      reasons.push("item_rights_approval_not_declared");
    }
  }
  const exclusionIds = new Set<string>();
  for (const exclusion of value.preRunExclusions) {
    if (
      !ids.has(exclusion.itemId) ||
      exclusionIds.has(exclusion.itemId) ||
      !nonEmpty(exclusion.reason) ||
      exclusion.reason.length > 240
    ) {
      reasons.push("pre_run_exclusion_invalid");
    }
    exclusionIds.add(exclusion.itemId);
  }
  return unique(reasons);
}

export function validateManifestForGate(
  manifest: DatasetManifest,
  gateId: ReleaseGateId,
): readonly string[] {
  const reasons = [...validateDatasetManifest(manifest)];
  const contract = GATE_CONTRACTS[gateId];
  if (!manifest.intendedGates.includes(gateId)) {
    reasons.push("dataset_not_intended_for_gate");
  }
  if (manifest.authority !== "authoritative") {
    reasons.push("fixture_dataset_is_not_authoritative");
  }
  const excluded = new Set(
    manifest.preRunExclusions.map((exclusion) => exclusion.itemId),
  );
  const eligible = manifest.items.filter(
    (item) => !excluded.has(item.id) && itemKindForGate(item, gateId),
  );
  if (eligible.length < contract.minimumItems) {
    reasons.push("dataset_sample_count_incomplete");
  }
  const strata = new Set(eligible.flatMap((item) => item.strata));
  for (const required of contract.requiredStrata) {
    if (!strata.has(required)) {
      reasons.push(`required_stratum_missing:${required}`);
    }
  }
  if (
    gateId === "week1.audio" &&
    new Set(
      eligible
        .filter((item) => item.kind === "audio-script")
        .map((item) => item.courseId),
    ).size < 5
  ) {
    reasons.push("audio_course_profile_incomplete");
  }
  return unique(reasons);
}

export function validateRunIdentity(
  run: GateRun,
  manifest: DatasetManifest,
): readonly string[] {
  const reasons: string[] = [];
  const contract = GATE_CONTRACTS[run.gateId];
  const metadata = run.metadata;
  if (
    !OPAQUE_ID.test(metadata.runId) ||
    !COMMIT.test(metadata.sourceCommit) ||
    !SHA256.test(stripSha256Prefix(metadata.deployableArtifactDigest)) ||
    !SHA256.test(stripSha256Prefix(metadata.infrastructureFingerprint))
  ) {
    reasons.push("run_identity_invalid");
  }
  if (
    !validTimestampOrder(metadata.startedAt, metadata.completedAt) ||
    metadata.declaredSeed !== manifest.selection.seed
  ) {
    reasons.push("run_time_or_seed_invalid");
  }
  if (
    !contract.allowedExecutionBoundaries.includes(metadata.executionBoundary) ||
    metadata.concurrency !== contract.requiredConcurrency ||
    metadata.repetitions < contract.minimumRepetitions
  ) {
    reasons.push("execution_profile_invalid");
  }
  if (
    (run.gateId === "week1.performance" || run.gateId === "week1.audio") &&
    (metadata.cacheProfile.application !== "cold" ||
      metadata.cacheProfile.model !== "cold")
  ) {
    reasons.push("cold_cache_profile_missing");
  }
  for (const key of contract.requiredDependencyKeys) {
    if (
      !SHA256.test(
        stripSha256Prefix(metadata.dependencyFingerprints[key] ?? ""),
      )
    ) {
      reasons.push(`dependency_fingerprint_missing:${key}`);
    }
  }
  for (const kind of contract.requiredMutableEvidenceKinds) {
    if (
      !metadata.mutableEvidence.some(
        (reference) =>
          reference.kind === kind &&
          reference.status === "valid" &&
          safeReference(reference.reference) &&
          Date.parse(reference.validUntil) > Date.parse(metadata.completedAt),
      )
    ) {
      reasons.push(`mutable_evidence_missing_or_stale:${kind}`);
    }
  }
  return unique(reasons);
}

export function safeReference(value: string): boolean {
  return SAFE_REFERENCE.test(value) && !/@/.test(value);
}

export function stripSha256Prefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function validateItem(
  item: DatasetItem,
  ids: Set<string>,
  reasons: string[],
): void {
  if (!OPAQUE_ID.test(item.id) || ids.has(item.id)) {
    reasons.push("dataset_item_identity_invalid_or_duplicate");
  }
  ids.add(item.id);
  if (!SHA256.test(item.sha256)) {
    reasons.push("dataset_item_digest_invalid");
  }
  if (!safeReference(item.rightsApprovalReference)) {
    reasons.push("item_rights_approval_missing_or_invalid");
  }
  if (
    item.strata.length === 0 ||
    new Set(item.strata).size !== item.strata.length ||
    item.strata.some(
      (stratum) => !/^[a-z0-9][a-z0-9:._/-]{2,80}$/.test(stratum),
    )
  ) {
    reasons.push("dataset_item_strata_invalid");
  }
  if (item.kind === "document") {
    if (
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 512 * 1_024 ||
      item.byteLength > 20 * 1_024 * 1_024 ||
      (item.pageCount !== null &&
        (!Number.isSafeInteger(item.pageCount) ||
          item.pageCount < 5 ||
          item.pageCount > 200)) ||
      !safeReference(item.standardProfileEligibilityReference)
    ) {
      reasons.push("standard_document_profile_invalid");
    }
    const expectedStrata = [
      `format:${item.format}`,
      `structure:${item.complexity}`,
      ...(item.hasImages ? ["content:images"] : []),
      ...(item.hasTables ? ["content:tables"] : []),
      sizeStratum(item.byteLength),
      ...(item.pageCount === null ? [] : [pageStratum(item.pageCount)]),
    ];
    if (expectedStrata.some((stratum) => !item.strata.includes(stratum))) {
      reasons.push("document_strata_mismatch");
    }
  } else if (item.kind === "audio-script") {
    if (
      !OPAQUE_ID.test(item.courseId) ||
      !Number.isSafeInteger(item.scriptByteLength) ||
      item.scriptByteLength < 1
    ) {
      reasons.push("audio_script_profile_invalid");
    }
  } else if (item.kind === "upload-security") {
    if (!nonEmpty(item.expectedOutcome)) {
      reasons.push("upload_security_expectation_invalid");
    }
  } else if (
    item.threatClasses.length === 0 ||
    item.threatClasses.some(
      (threat) => !item.strata.includes(`threat:${threat}`),
    )
  ) {
    reasons.push("adversarial_threat_classes_missing_or_mismatched");
  }
}

function pageStratum(pageCount: number): string {
  if (pageCount < 50) {
    return "pages:5-49";
  }
  return pageCount < 150 ? "pages:50-149" : "pages:150-200";
}

function sizeStratum(byteLength: number): string {
  if (byteLength < 5 * 1_024 * 1_024) {
    return "size:0.5-4.9mb";
  }
  return byteLength < 15 * 1_024 * 1_024 ? "size:5-14.9mb" : "size:15-20mb";
}

function itemKindForGate(item: DatasetItem, gateId: ReleaseGateId): boolean {
  return (
    (gateId === "week1.performance" && item.kind === "document") ||
    (gateId === "week1.audio" && item.kind === "audio-script") ||
    (gateId === "week1.upload-security" && item.kind === "upload-security") ||
    (gateId === "week1.adversarial" && item.kind === "adversarial-document")
  );
}

function validTimestampOrder(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0 && value.length <= 240;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
