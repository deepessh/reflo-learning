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

`pnpm package` stages independently deployable outputs under `.artifacts/`. The web artifact is static; API and jobs artifacts include their production workspace dependencies.
