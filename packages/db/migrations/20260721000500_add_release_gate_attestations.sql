-- migrate:up

CREATE TABLE release_gate_attestation (
  environment text NOT NULL CHECK (environment IN ('staging', 'pilot')),
  gate_id text NOT NULL CHECK (
    gate_id IN (
      'week1.performance',
      'week1.audio',
      'week1.upload-security',
      'week1.adversarial'
    )
  ),
  evidence_bundle_digest text NOT NULL CHECK (
    evidence_bundle_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  evidence_bundle_reference text NOT NULL CHECK (
    length(evidence_bundle_reference) BETWEEN 5 AND 300
  ),
  deployable_artifact_digest text NOT NULL CHECK (
    deployable_artifact_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  attestation_version text NOT NULL CHECK (
    attestation_version = 'gate-attestation-v1'
  ),
  contract_version text NOT NULL CHECK (
    contract_version = 'evaluation-contract-v1'
  ),
  status text NOT NULL CHECK (
    status IN ('passed', 'failed', 'indeterminate')
  ),
  dependency_fingerprints jsonb NOT NULL CHECK (
    jsonb_typeof(dependency_fingerprints) = 'object'
    AND dependency_fingerprints <> '{}'::jsonb
  ),
  mutable_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(mutable_evidence) = 'array'
  ),
  publisher_id text NOT NULL CHECK (publisher_id ~ '^[a-zA-Z0-9_-]{8,128}$'),
  publisher_authorization_reference text NOT NULL CHECK (
    length(publisher_authorization_reference) BETWEEN 5 AND 300
  ),
  published_at timestamptz NOT NULL,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, gate_id, evidence_bundle_digest),
  CHECK (superseded_at IS NULL OR superseded_at >= published_at)
);

CREATE UNIQUE INDEX release_gate_attestation_current_idx
  ON release_gate_attestation (environment, gate_id)
  WHERE superseded_at IS NULL;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
