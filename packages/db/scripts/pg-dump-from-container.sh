#!/usr/bin/env sh
set -eu

if [ -z "${REFLO_POSTGRES_CONTAINER_ID:-}" ]; then
  echo "REFLO_POSTGRES_CONTAINER_ID is required" >&2
  exit 1
fi

exec docker exec "$REFLO_POSTGRES_CONTAINER_ID" pg_dump "$@"
