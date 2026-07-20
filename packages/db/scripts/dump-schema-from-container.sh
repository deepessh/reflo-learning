#!/usr/bin/env sh

set -eu

: "${REFLO_POSTGRES_CONTAINER_ID:?REFLO_POSTGRES_CONTAINER_ID is required}"
command -v docker >/dev/null 2>&1 || {
  echo "docker is required for the canonical schema dump" >&2
  exit 1
}

REFLO_DB_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_DB_CLIENT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reflo-pg-client.XXXXXX")

cleanup() {
  rm -rf -- "$REFLO_DB_CLIENT_DIR"
}
trap cleanup EXIT INT TERM

ln -s "$REFLO_DB_PACKAGE_ROOT/scripts/pg-dump-from-container.sh" "$REFLO_DB_CLIENT_DIR/pg_dump"
PATH="$REFLO_DB_CLIENT_DIR:$PATH" node "$REFLO_DB_PACKAGE_ROOT/scripts/dump-schema.mjs"
