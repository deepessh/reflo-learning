-- Local-stack-only allowance for the isolated LiteLLM development profile.
-- Canonical migrations and packages/db/schema.sql intentionally remain
-- production-strict and accept only D-GH-9 embedding-v1.

ALTER TABLE source_embedding_generation
  DROP CONSTRAINT IF EXISTS source_embedding_generation_profile_version_check;

ALTER TABLE source_embedding_generation
  ADD CONSTRAINT source_embedding_generation_profile_version_check CHECK (
    profile_version = 'embedding-v1'
    OR profile_version ~ '^litellm-dev-embedding-v1-[a-f0-9]{16}$'
  );
