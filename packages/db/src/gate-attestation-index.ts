import {
  EVALUATION_CONTRACT_VERSION,
  GATE_ATTESTATION_VERSION,
  RELEASE_GATE_IDS,
  canonicalJson,
  safeReference,
  type GateAttestation,
  type GateAttestationIndexPort,
} from "@reflo/evaluation";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

interface AttestationRow extends Record<string, unknown> {
  attestation_version: GateAttestation["attestationVersion"];
  contract_version: GateAttestation["contractVersion"];
  dependency_fingerprints: Record<string, string>;
  deployable_artifact_digest: string;
  environment: GateAttestation["environment"];
  evidence_bundle_digest: string;
  evidence_bundle_reference: string;
  gate_id: GateAttestation["gateId"];
  mutable_evidence: GateAttestation["mutableEvidence"];
  published_at: Date;
  publisher_authorization_reference: string;
  publisher_id: string;
  status: GateAttestation["status"];
}

export class PostgresGateAttestationIndex implements GateAttestationIndexPort {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new Error("gate_attestation_configuration_invalid");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async publish(attestation: GateAttestation): Promise<void> {
    validateAttestation(attestation);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [attestation.environment, attestation.gateId],
      );
      const current = await selectCurrent(
        client,
        attestation.environment,
        attestation.gateId,
      );
      if (current !== null) {
        if (current.evidenceBundleDigest === attestation.evidenceBundleDigest) {
          if (canonicalJson(current) !== canonicalJson(attestation)) {
            throw new Error("gate_attestation_digest_conflict");
          }
          await client.query("COMMIT");
          return;
        }
        if (
          Date.parse(current.publishedAt) >= Date.parse(attestation.publishedAt)
        ) {
          throw new Error("gate_attestation_not_newer");
        }
        await client.query(
          `UPDATE release_gate_attestation
           SET superseded_at = $1
           WHERE environment = $2
             AND gate_id = $3
             AND superseded_at IS NULL`,
          [
            attestation.publishedAt,
            attestation.environment,
            attestation.gateId,
          ],
        );
      }
      await client.query(
        `INSERT INTO release_gate_attestation
           (environment, gate_id, evidence_bundle_digest,
            evidence_bundle_reference, deployable_artifact_digest,
            attestation_version, contract_version, status,
            dependency_fingerprints, mutable_evidence, publisher_id,
            publisher_authorization_reference, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                 $11, $12, $13)`,
        [
          attestation.environment,
          attestation.gateId,
          attestation.evidenceBundleDigest,
          attestation.evidenceBundleReference,
          attestation.deployableArtifactDigest,
          attestation.attestationVersion,
          attestation.contractVersion,
          attestation.status,
          JSON.stringify(attestation.dependencyFingerprints),
          JSON.stringify(attestation.mutableEvidence),
          attestation.publisherId,
          attestation.publisherAuthorizationReference,
          attestation.publishedAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readCurrent(
    environment: GateAttestation["environment"],
    gateId: GateAttestation["gateId"],
  ): Promise<GateAttestation | null> {
    if (
      !["staging", "pilot"].includes(environment) ||
      !(RELEASE_GATE_IDS as readonly string[]).includes(gateId)
    ) {
      throw new Error("gate_attestation_identity_invalid");
    }
    const client = await this.#pool.connect();
    try {
      return selectCurrent(client, environment, gateId);
    } finally {
      client.release();
    }
  }
}

async function selectCurrent(
  client: PoolClient,
  environment: GateAttestation["environment"],
  gateId: GateAttestation["gateId"],
): Promise<GateAttestation | null> {
  const result = await client.query<AttestationRow>(
    `SELECT attestation_version, contract_version,
            dependency_fingerprints, deployable_artifact_digest,
            environment, evidence_bundle_digest, evidence_bundle_reference,
            gate_id, mutable_evidence, published_at,
            publisher_authorization_reference, publisher_id, status
     FROM release_gate_attestation
     WHERE environment = $1 AND gate_id = $2 AND superseded_at IS NULL`,
    [environment, gateId],
  );
  const row = result.rows[0];
  return row === undefined ? null : fromRow(row);
}

function fromRow(row: AttestationRow): GateAttestation {
  const attestation: GateAttestation = {
    attestationVersion: row.attestation_version,
    contractVersion: row.contract_version,
    dependencyFingerprints: row.dependency_fingerprints,
    deployableArtifactDigest: row.deployable_artifact_digest,
    environment: row.environment,
    evidenceBundleDigest: row.evidence_bundle_digest,
    evidenceBundleReference: row.evidence_bundle_reference,
    gateId: row.gate_id,
    mutableEvidence: row.mutable_evidence,
    publishedAt: row.published_at.toISOString(),
    publisherAuthorizationReference: row.publisher_authorization_reference,
    publisherId: row.publisher_id,
    status: row.status,
  };
  validateAttestation(attestation);
  return attestation;
}

function validateAttestation(attestation: GateAttestation): void {
  const mutableEvidenceValid = attestation.mutableEvidence.every(
    (evidence) =>
      ["approval", "capacity", "legal", "privacy", "quota", "rights"].includes(
        evidence.kind,
      ) &&
      safeReference(evidence.reference) &&
      ["invalid", "valid"].includes(evidence.status) &&
      Number.isFinite(Date.parse(evidence.validUntil)),
  );
  if (
    attestation.attestationVersion !== GATE_ATTESTATION_VERSION ||
    attestation.contractVersion !== EVALUATION_CONTRACT_VERSION ||
    !["staging", "pilot"].includes(attestation.environment) ||
    !(RELEASE_GATE_IDS as readonly string[]).includes(attestation.gateId) ||
    !SHA256.test(attestation.evidenceBundleDigest) ||
    !SHA256.test(attestation.deployableArtifactDigest) ||
    !safeReference(attestation.evidenceBundleReference) ||
    !safeReference(attestation.publisherAuthorizationReference) ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(attestation.publisherId) ||
    !Number.isFinite(Date.parse(attestation.publishedAt)) ||
    !["failed", "indeterminate", "passed"].includes(attestation.status) ||
    !mutableEvidenceValid ||
    Object.keys(attestation.dependencyFingerprints).length === 0 ||
    Object.values(attestation.dependencyFingerprints).some(
      (digest) => !/^(?:sha256:)?[a-f0-9]{64}$/.test(digest),
    )
  ) {
    throw new Error("gate_attestation_invalid");
  }
}
