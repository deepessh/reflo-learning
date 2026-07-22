# Reflo

Reflo is a pnpm/Turborepo monorepo with three independently deployable applications:

- `apps/web`: static Next.js PWA output for CDN delivery
- `apps/api`: Node.js API and learner/session orchestrator for ECS
- `apps/jobs`: event, cron, and queue handlers for Function Compute

Shared packages live under `packages/` and expose public package entry points. Applications may import shared packages, but never another application.

## Local commands

Node.js 24.18.0 LTS and pnpm 10.34.5 are pinned for repeatable local and CI behavior.

Run the toolchain doctor before setup. It distinguishes missing tools from
installed commands whose directory is absent from `PATH` and reports when exact
PostgreSQL validation is available only in CI.

```sh
scripts/doctor.sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm package
```

Copy `.env.example` to `.env` only when overriding local defaults. Never commit `.env` files or secret values.

## Local supporting services

The Compose-compatible developer stack includes only dependencies exercised by
implemented runtime ports: the exact repository PostgreSQL 16.9 service for the
transactional RDS-owned schema, plus a separate digest-pinned PostgreSQL 16 /
pgvector 0.8.1 development store for the retrieval-owned AnalyticDB-compatible
schema. It intentionally does not start Redis, RocketMQ, an object-store
emulator, or an SMTP capture service until a runnable local adapter needs them.
This environment is not an Alibaba emulator or production-deployment proof.

Docker with the Compose plugin is required. The helper fixes the project name
to `reflo-local`, binds database ports only to `127.0.0.1`, and generates random
credentials in ignored, mode-0600 files under `.reflo/local-stack/`.

```sh
# Start both dependencies and wait for bounded health checks.
scripts/local-stack.sh start

# Start if needed, apply @reflo/db migrations, and apply the separate
# @reflo/retrieval vector schema.
scripts/local-stack.sh setup

# Inspect service health and actionable optional-worker states.
scripts/local-stack.sh status

# Print the path to the generated DATABASE_URL, TEST_DATABASE_URL,
# REFLO_VECTOR_DATABASE_URL, and canonical pg_dump container configuration
# without printing credentials.
scripts/local-stack.sh env
```

`setup` requires the repository-pinned Node.js 24.18.0 and pnpm 10.34.5. Source
the generated application environment only in a trusted local shell when a
runtime or integration test needs it. The transactional and vector databases
have separate users, databases, and named volumes; retrieval SQL is never
applied to RDS. The generated pg_dump settings rewrite only the loopback host
authority to the container's PostgreSQL port, preserving the database selected
by dbmate so canonical schema tests still use the exact pinned client.

Lifecycle operations are scoped to the fixed `reflo-local` Compose project:

```sh
scripts/local-stack.sh validate   # validate config; start nothing
scripts/local-stack.sh rebuild    # pull/recreate, preserve data, reapply schemas
scripts/local-stack.sh teardown   # remove containers/network, preserve data
scripts/local-stack.sh reset      # also remove only reflo-local named data volumes
```

The ingestion worker remains outside Docker Compose because D-GH-8 requires
rootless Podman 6.0.1, a signed ClamAV snapshot, and job-scoped networkless
mounts. The Piper worker remains unavailable while its checked-in manifest is
`blocked` and lacks an admitted image and voice bundle. `worker-status` reports
the exact missing prerequisite instead of treating either path as ready.

## LiteLLM development smoke adapters

`@reflo/model-router/litellm` provides development-only OpenAI-compatible
adapters for the existing structured-generation, grounded-generation, grading,
dialogue, and embedding ports. The adapter factory requires `REFLO_ENV=dev`,
and the router independently rejects its descriptors in staging or pilot
composition. It does not add a generic completion API to feature packages.

The safe placeholders in `.env.example` assume a loopback LiteLLM proxy. Plain
HTTP is accepted only for loopback hosts; non-loopback gateways must use HTTPS.
Use only synthetic or rights-cleared non-PII fixtures. Gateway caching, logging,
retry, and fallback behavior may be enabled for local smoke work, but the
resulting provenance is labeled `development_only` and cannot satisfy Reflo's
authoritative privacy, retry, provenance, quality, embedding, latency, or
release gates. Raw provider responses are neither returned nor persisted.

LiteLLM embedding calls request and require 1,024 float dimensions. The adapter
derives a distinct `litellm-dev-embedding-v1-<fingerprint>` profile from the
gateway origin, configured embedding alias, dimensions, and adapter contract.
It never labels those vectors as D-GH-9 `embedding-v1`. Search fails closed when
the active generation does not match the currently configured profile, model,
endpoint, or adapter. After changing the LiteLLM base URL or embedding model,
discard the local generated state and rebuild before indexing or searching:

```sh
scripts/local-stack.sh reset
scripts/local-stack.sh setup
```

`reset` removes only the fixed `reflo-local` Compose project's containers,
network, and named development volumes. It is intentionally a clean local
re-embed workflow; do not use LiteLLM vectors in a staging or pilot data store.

The API leaves authentication disabled only for local development. Staging and
pilot composition require the allowlisted DirectMail adapter, exact HTTPS
callback origins, an ECS RAM role, explicit limits within the verified free
allowance, and four distinct 32-byte authentication keys. Production injects
those keys and the database credential from KMS Secrets Manager; static Alibaba
access keys are not accepted by the adapter.

`pnpm package` stages independently deployable outputs under `.artifacts/`. The web artifact is static; API and jobs artifacts include their production workspace dependencies.
