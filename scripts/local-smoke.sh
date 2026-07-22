#!/usr/bin/env sh

set -eu

REFLO_SMOKE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_SMOKE_APP_ENV="$REFLO_SMOKE_ROOT/.reflo/local-stack/app.env"

"$REFLO_SMOKE_ROOT/scripts/local-stack.sh" setup

if [ ! -f "$REFLO_SMOKE_APP_ENV" ]; then
  echo "ERROR: local stack application environment is missing; rerun scripts/local-stack.sh setup" >&2
  exit 1
fi

set -a
. "$REFLO_SMOKE_APP_ENV"
set +a

cd "$REFLO_SMOKE_ROOT"
corepack pnpm --filter @reflo/dev-smoke... build
exec corepack pnpm --filter @reflo/dev-smoke smoke
