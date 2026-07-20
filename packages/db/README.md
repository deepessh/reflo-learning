# `@reflo/db`

This package is the sole owner of Reflo's transactional PostgreSQL schema.

- Add append-only timestamped SQL migrations under `migrations/`.
- Regenerate and commit `schema.sql` with `pnpm --filter @reflo/db db:dump`.
- CI runs `pg_dump` from its digest-pinned PostgreSQL service container so the
  checked-in schema is compared with the exact client version that generated it.
- Application code must use deliberate public repositories added to this package; raw database clients are forbidden elsewhere.
- Independently deployed non-Node workers must write through versioned API or `reflo-event-envelope-v1` RocketMQ command contracts. They do not connect directly to core RDS tables.
- Production migrations are serialized deployment operations run through `pnpm --filter @reflo/db db:migrate`; applications and Function Compute handlers never migrate during startup.

The pinned dbmate 2.34.1 artifacts do not expose the `--strict` flag advertised by that tag's README. `scripts/strict-migrate.mjs` provides the required fail-on-out-of-order check against `schema_migrations`, then delegates the schema change itself to dbmate 2.34.1. Dbmate remains the sole migration engine.

`TEST_DATABASE_URL` enables the real-PostgreSQL integration suite. The suite creates and drops an isolated database beneath that server and never uses the named database for test data.
