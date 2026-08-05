-- migrate:up

ALTER TABLE activation_generation_operation
  DROP CONSTRAINT activation_generation_operation_generation_version_check;

ALTER TABLE activation_generation_operation
  ADD CONSTRAINT activation_generation_operation_generation_version_check
  CHECK (generation_version IN (
    'activation-generation-v1',
    'activation-generation-v2'
  ));

ALTER TABLE quiz_bank
  DROP CONSTRAINT quiz_bank_generation_version_check;

ALTER TABLE quiz_bank
  ADD CONSTRAINT quiz_bank_generation_version_check
  CHECK (generation_version IN (
    'activation-generation-v1',
    'activation-generation-v2'
  ));

-- migrate:down
-- Forward-only. Restore through a reviewed compensating migration.
