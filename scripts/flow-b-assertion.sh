#!/usr/bin/env sh

set -eu

REFLO_FLOW_B_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_FLOW_B_APP_ENV="$REFLO_FLOW_B_ROOT/.reflo/local-stack/app.env"

if [ "$#" -ne 1 ]; then
  echo "Usage: REFLO_FLOW_B_BROWSER_EXECUTABLE=/absolute/path/to/chrome scripts/flow-b-assertion.sh <new-record.json>" >&2
  exit 64
fi
if [ ! -f "$REFLO_FLOW_B_APP_ENV" ]; then
  echo "ERROR: local stack environment is missing; run scripts/local-stack.sh setup" >&2
  exit 1
fi
: "${REFLO_FLOW_B_BROWSER_EXECUTABLE:?REFLO_FLOW_B_BROWSER_EXECUTABLE is required}"

set -a
. "$REFLO_FLOW_B_APP_ENV"
set +a

cd "$REFLO_FLOW_B_ROOT"
exec corepack pnpm --filter @reflo/flow-b-assertion local:run "$1"
