# `@reflo/db`

This package is the sole owner of Reflo's transactional PostgreSQL schema.

- Add append-only timestamped SQL migrations under `migrations/`.
- Regenerate and commit `schema.sql` only with
  `REFLO_POSTGRES_CONTAINER_ID="<container>" pnpm --filter @reflo/db db:dump`.
  That command uses `scripts/dump-schema-from-container.sh`, which exposes
  `scripts/pg-dump-from-container.sh` as `pg_dump` and delegates to the exact
  client inside the digest-pinned PostgreSQL 16.9 service image declared in
  `scripts/toolchain-versions.sh`. Never edit or hand-edit `schema.sql`; if the
  pinned container is unavailable, use CI to validate and regenerate later in
  the canonical environment.
- Application code must use deliberate public repositories added to this package; raw database clients are forbidden elsewhere.
- Independently deployed non-Node workers must write through versioned API or `reflo-event-envelope-v1` RocketMQ command contracts. They do not connect directly to core RDS tables.
- Production migrations are serialized deployment operations run through `pnpm --filter @reflo/db db:migrate`; applications and Function Compute handlers never migrate during startup.

The pinned dbmate 2.34.1 artifacts do not expose the `--strict` flag advertised by that tag's README. `scripts/strict-migrate.mjs` provides the required fail-on-out-of-order check against `schema_migrations`, then delegates the schema change itself to dbmate 2.34.1. Dbmate remains the sole migration engine.

`TEST_DATABASE_URL` enables the real-PostgreSQL integration suite. The suite creates and drops an isolated database beneath that server and never uses the named database for test data.
