-- migrate:up

-- Contract v1 remains immutable history, but it cannot remain the current
-- release verdict after the PDF-only Demo Day contract becomes authoritative.
UPDATE release_gate_attestation
SET superseded_at = GREATEST(published_at, statement_timestamp())
WHERE superseded_at IS NULL
  AND attestation_version = 'gate-attestation-v1'
  AND contract_version = 'evaluation-contract-v1';

ALTER TABLE release_gate_attestation
  DROP CONSTRAINT release_gate_attestation_attestation_version_check,
  DROP CONSTRAINT release_gate_attestation_contract_version_check;

ALTER TABLE release_gate_attestation
  ADD CONSTRAINT release_gate_attestation_contract_pair_check CHECK (
    (
      attestation_version = 'gate-attestation-v1'
      AND contract_version = 'evaluation-contract-v1'
      AND superseded_at IS NOT NULL
    )
    OR (
      attestation_version = 'gate-attestation-v2'
      AND contract_version = 'evaluation-contract-v2'
    )
  );

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
