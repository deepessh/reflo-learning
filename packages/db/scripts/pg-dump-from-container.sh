#!/usr/bin/env sh
set -eu

if [ -z "${REFLO_POSTGRES_CONTAINER_ID:-}" ]; then
  echo "REFLO_POSTGRES_CONTAINER_ID is required" >&2
  exit 1
fi

if [ -n "${REFLO_POSTGRES_CONTAINER_REWRITE_FROM:-}" ] || [ -n "${REFLO_POSTGRES_CONTAINER_REWRITE_TO:-}" ]; then
  if [ -z "${REFLO_POSTGRES_CONTAINER_REWRITE_FROM:-}" ] || [ -z "${REFLO_POSTGRES_CONTAINER_REWRITE_TO:-}" ]; then
    echo "REFLO_POSTGRES_CONTAINER_REWRITE_FROM and REFLO_POSTGRES_CONTAINER_REWRITE_TO must be set together" >&2
    exit 1
  fi
  case "$REFLO_POSTGRES_CONTAINER_REWRITE_FROM$REFLO_POSTGRES_CONTAINER_REWRITE_TO" in
    *[!A-Za-z0-9.:-]* )
      echo "PostgreSQL container authority rewrites contain unsafe characters" >&2
      exit 1
      ;;
  esac

  REFLO_PG_DUMP_ARGUMENT_BOUNDARY=__REFLO_PG_DUMP_ARGUMENT_BOUNDARY_0f44f746__
  rewrite_and_exec() {
    if [ "$1" = "$REFLO_PG_DUMP_ARGUMENT_BOUNDARY" ]; then
      shift
      exec docker exec "$REFLO_POSTGRES_CONTAINER_ID" pg_dump "$@"
    fi

    REFLO_PG_DUMP_ARGUMENT=$1
    shift
    case "$REFLO_PG_DUMP_ARGUMENT" in
      postgres://* | postgresql://* | --dbname=postgres://* | --dbname=postgresql://* )
        case "$REFLO_PG_DUMP_ARGUMENT" in
          *"$REFLO_POSTGRES_CONTAINER_REWRITE_FROM"* )
            REFLO_PG_DUMP_PREFIX=${REFLO_PG_DUMP_ARGUMENT%%"$REFLO_POSTGRES_CONTAINER_REWRITE_FROM"*}
            REFLO_PG_DUMP_SUFFIX=${REFLO_PG_DUMP_ARGUMENT#*"$REFLO_POSTGRES_CONTAINER_REWRITE_FROM"}
            REFLO_PG_DUMP_ARGUMENT=$REFLO_PG_DUMP_PREFIX$REFLO_POSTGRES_CONTAINER_REWRITE_TO$REFLO_PG_DUMP_SUFFIX
            ;;
        esac
        ;;
    esac
    rewrite_and_exec "$@" "$REFLO_PG_DUMP_ARGUMENT"
  }

  rewrite_and_exec "$@" "$REFLO_PG_DUMP_ARGUMENT_BOUNDARY"
fi

exec docker exec "$REFLO_POSTGRES_CONTAINER_ID" pg_dump "$@"
