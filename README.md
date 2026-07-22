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

The ingestion worker remains outside Docker Compose because D-GH-8 pins
rootless Podman 6.0.1 for the production ECS parser pool and requires a signed
ClamAV snapshot plus job-scoped networkless mounts. The connected development
smoke accepts only Podman 5.8.3 or 6.0.1: 5.8.3 is the newest official release
with a Darwin AMD64 installer, while 6.0.x macOS artifacts are ARM64-only. This
compatibility allowance never changes the production runtime pin or release
evidence. Piper production activation remains unavailable while its checked-in
manifest is `blocked` and lacks an admitted image and voice bundle. The
connected development smoke below may exercise the candidate through explicit
local Python and voice paths without changing that status. `worker-status`
reports the exact boundary instead of treating either path as production-ready.

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

## fal development video adapter

`@reflo/model-router/fal` provides one development-only adapter for the
existing `media.video.v1` capability. It uses fal's asynchronous queue API and
is rejected unless `REFLO_ENV=dev`. The checked-in
`REFLO_LOCAL_SMOKE_VIDEO=false` default leaves the adapter uncomposed, and the
server-side `p1.media.video` guard remains independently required.

When explicitly enabled, the adapter submits one five-second 720p clip, polls
the provider queue, validates the returned HTTPS MP4 metadata, and lets the
trusted local smoke composition copy the bytes into the ignored private
`.reflo/local-smoke/artifacts/owners/...` path. Provider filenames and URLs do
not select the local object key and are not persisted in the replay manifest.
The request sends the prepared visual brief, not raw source-span text, disables
fal JSON input/output retention, provider retries, and provider model
fallbacks, and applies the bounded media lifetime from
`REFLO_FAL_MEDIA_LIFETIME_SECONDS`. See fal's official
[queue](https://fal.ai/docs/documentation/model-apis/inference/queue) and
[retention](https://fal.ai/docs/documentation/model-apis/media-expiration)
documentation for those provider behaviors.

Set `REFLO_FAL_KEY`, `REFLO_FAL_VIDEO_MODEL`, and
`REFLO_FAL_MEDIA_LIFETIME_SECONDS` from an ignored local environment file, then
set `REFLO_LOCAL_SMOKE_VIDEO=true` only for a synthetic or rights-cleared,
non-PII experiment. Enabling it submits an external media job and does not
authorize paid usage or new capacity. If fal is disabled or unavailable, the
connected smoke still completes its text and audio path and reports video as a
separate skipped component.

The five-second result is prototype evidence only. A 60–120 second explainer
would require a separately designed storyboard of multiple short clips,
cross-clip visual continuity, narration/audio timing, trusted muxing or
stitching, and final media validation. None of that is a core local-stack
prerequisite, Wanx production evidence, or a Week 1 release-gate pass.

The API leaves authentication disabled only for local development. Staging and
pilot composition require the allowlisted DirectMail adapter, exact HTTPS
callback origins, an ECS RAM role, explicit limits within the verified free
allowance, and four distinct 32-byte authentication keys. Production injects
those keys and the database credential from KMS Secrets Manager; static Alibaba
access keys are not accepted by the adapter.

## Connected local development smoke flow

The connected smoke command joins the committed synthetic, non-PII PDF fixture
to the implemented admission, isolated parsing, chunking, LiteLLM development
embedding, owner-scoped pgvector retrieval, curriculum, activation lesson and
quiz, narration, and Piper audio paths. RDS stores the source-backed curriculum,
lesson, quiz, provenance, narration, audio metadata, and idempotent operation
state. Private development artifacts are written under the ignored
`.reflo/local-smoke/` root. Running the command again replays the terminal
ingestion, activation, and audio operations and fails if persisted logical
artifact counts change.

Prepare these local-only prerequisites first:

- development-compatible Podman 5.8.3 or production-pinned 6.0.1, the locally
  built pinned ingestion image, its inspected digest, the verified ClamAV
  snapshot directory, and pinned English tessdata;
- a reachable development LiteLLM gateway with JSON-capable text and exactly
  1,024-dimensional embedding aliases;
- an absolute Python environment containing `piper-tts==1.4.2` plus the
  digest-pinned LJSpeech voice model and config from the checked-in Piper
  manifest.

Export the `REFLO_LOCAL_*` and `REFLO_LITELLM_*` values documented in
`.env.example`, then run one command:

```sh
corepack pnpm smoke:local
```

The command starts and readies the two local database services, applies the
production schemas plus isolated local-only LiteLLM profile tables, builds the
participating packages, runs the flow, and emits one bounded JSON summary. A
missing local service, LiteLLM alias, embedding dimension, ingestion worker, or
Piper prerequisite fails with a component name and corrective action. Video is
reported separately and never changes core success when its P1 flag is
disabled or the optional fal experiment is unavailable.

This connected mode is development integration evidence only. Unit and
integration suites remain deterministic failure/replay evidence. The seeded
offline demo is a separate service-worker bundle that must work without public
internet, model APIs, production backend, or CDN. Authoritative performance,
audio, adversarial, privacy, security, provider, quota, and release-gate
evaluation runs only in the applicable Alibaba target environment under the
repository evaluation contract; this command cannot satisfy any of them.

`pnpm package` stages independently deployable outputs under `.artifacts/`. The web artifact is static; API and jobs artifacts include their production workspace dependencies.
