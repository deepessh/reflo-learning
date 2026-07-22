import {
  EVALUATION_CONTRACT_VERSION,
  GATE_ATTESTATION_VERSION,
  RELEASE_GATE_IDS,
  type CurrentReleaseIdentity,
  type EvidenceBundle,
  type GateAttestation,
} from "./contracts.js";
import { verifyEvidenceBundle } from "./evidence.js";
import { safeReference } from "./validation.js";

export interface GateAttestationIndexPort {
  publish(attestation: GateAttestation): Promise<void>;
  readCurrent(
    environment: GateAttestation["environment"],
    gateId: GateAttestation["gateId"],
  ): Promise<GateAttestation | null>;
}

export interface PublisherAuthorizationPort {
  authorize(input: {
    readonly environment: GateAttestation["environment"];
    readonly gateId: GateAttestation["gateId"];
    readonly publisherAuthorizationReference: string;
    readonly publisherId: string;
  }): Promise<boolean>;
}

export class GateAttestationPublisher {
  constructor(
    private readonly authorization: PublisherAuthorizationPort,
    private readonly index: GateAttestationIndexPort,
  ) {}

  async publish(input: {
    readonly bundle: EvidenceBundle;
    readonly evidenceBundleReference: string;
    readonly publishedAt: string;
    readonly publisherAuthorizationReference: string;
    readonly publisherId: string;
  }): Promise<GateAttestation> {
    if (
      !verifyEvidenceBundle(input.bundle) ||
      !safeReference(input.evidenceBundleReference) ||
      !safeReference(input.publisherAuthorizationReference) ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(input.publisherId)
    ) {
      throw new Error("attestation_input_invalid");
    }
    const authorized = await this.authorization.authorize({
      environment: input.bundle.environment,
      gateId: input.bundle.gateId,
      publisherAuthorizationReference: input.publisherAuthorizationReference,
      publisherId: input.publisherId,
    });
    if (!authorized) {
      throw new Error("attestation_publisher_unauthorized");
    }
    const publishedAt = Date.parse(input.publishedAt);
    if (
      !Number.isFinite(publishedAt) ||
      publishedAt < Date.parse(input.bundle.completedAt)
    ) {
      throw new Error("attestation_time_invalid");
    }
    const mutableEvidenceCurrent = input.bundle.metadata.mutableEvidence.every(
      (evidence) =>
        evidence.status === "valid" &&
        safeReference(evidence.reference) &&
        Date.parse(evidence.validUntil) > publishedAt,
    );
    const attestation: GateAttestation = {
      attestationVersion: GATE_ATTESTATION_VERSION,
      contractVersion: EVALUATION_CONTRACT_VERSION,
      dependencyFingerprints: input.bundle.metadata.dependencyFingerprints,
      deployableArtifactDigest: input.bundle.deployableArtifactDigest,
      environment: input.bundle.environment,
      evidenceBundleDigest: input.bundle.bundleDigest,
      evidenceBundleReference: input.evidenceBundleReference,
      gateId: input.bundle.gateId,
      mutableEvidence: input.bundle.metadata.mutableEvidence,
      publishedAt: input.publishedAt,
      publisherAuthorizationReference: input.publisherAuthorizationReference,
      publisherId: input.publisherId,
      status: mutableEvidenceCurrent
        ? input.bundle.result.status
        : "indeterminate",
    };
    await this.index.publish(attestation);
    return attestation;
  }
}

export function isAttestationCurrent(
  attestation: GateAttestation | null,
  current: CurrentReleaseIdentity,
): boolean {
  if (
    attestation === null ||
    attestation.attestationVersion !== GATE_ATTESTATION_VERSION ||
    attestation.contractVersion !== EVALUATION_CONTRACT_VERSION ||
    !(RELEASE_GATE_IDS as readonly string[]).includes(attestation.gateId) ||
    !/^sha256:[a-f0-9]{64}$/.test(attestation.evidenceBundleDigest) ||
    !safeReference(attestation.evidenceBundleReference) ||
    !safeReference(attestation.publisherAuthorizationReference) ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(attestation.publisherId) ||
    attestation.status !== "passed" ||
    attestation.environment !== current.environment ||
    attestation.deployableArtifactDigest !== current.deployableArtifactDigest ||
    !current.evidenceBundleAvailable ||
    current.supersededByLaterRun
  ) {
    return false;
  }
  const now = Date.parse(current.now);
  if (!Number.isFinite(now)) {
    return false;
  }
  if (
    attestation.mutableEvidence.some(
      (evidence) =>
        evidence.status !== "valid" ||
        !safeReference(evidence.reference) ||
        !Number.isFinite(Date.parse(evidence.validUntil)) ||
        Date.parse(evidence.validUntil) <= now,
    )
  ) {
    return false;
  }
  const expected = Object.entries(current.dependencyFingerprints);
  return (
    expected.length > 0 &&
    expected.every(
      ([key, value]) => attestation.dependencyFingerprints[key] === value,
    ) &&
    Object.keys(attestation.dependencyFingerprints).length === expected.length
  );
}
