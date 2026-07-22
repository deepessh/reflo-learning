#!/usr/bin/env sh

set -eu

REFLO_LOCAL_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_LOCAL_COMPOSE_FILE="$REFLO_LOCAL_ROOT/compose.yaml"
REFLO_LOCAL_STATE_DIR="$REFLO_LOCAL_ROOT/.reflo/local-stack"
REFLO_LOCAL_COMPOSE_ENV="$REFLO_LOCAL_STATE_DIR/compose.env"
REFLO_LOCAL_APP_ENV="$REFLO_LOCAL_STATE_DIR/app.env"
REFLO_LOCAL_PROJECT=reflo-local
REFLO_LOCAL_RDS_CONTAINER=reflo-local-rds-1
REFLO_LOCAL_RETRIEVAL_SQL="$REFLO_LOCAL_ROOT/packages/retrieval/sql/20260721000100_vector_namespace_v1.sql"
REFLO_LOCAL_DEV_RETRIEVAL_SQL="$REFLO_LOCAL_ROOT/packages/retrieval/sql/20260722000100_litellm_dev_vector_namespace_v1.sql"
REFLO_LOCAL_DEV_RDS_SQL="$REFLO_LOCAL_ROOT/packages/db/sql/local-smoke-development-profile.sql"
REFLO_LOCAL_NODE_VERSION=24.18.0
REFLO_LOCAL_PNPM_VERSION=10.34.5

usage() {
  cat <<'EOF'
Usage: scripts/local-stack.sh <command>

Commands:
  start          Start the pinned local dependencies and wait for health.
  setup          Start dependencies, migrate RDS, and apply the vector schema.
  status         Show dependency health and optional-worker availability.
  worker-status  Report ingestion and Piper prerequisite states.
  env            Print the path to the generated application environment file.
  validate       Validate the Compose shape without starting services.
  rebuild        Pull and recreate containers while preserving local data.
  teardown       Stop and remove only the reflo-local containers and network.
  reset          Remove only reflo-local containers, network, and data volumes.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required: $2"
}

random_secret() {
  require_command openssl "install OpenSSL and retry"
  openssl rand -hex 24
}

write_compose_env() {
  if [ -f "$REFLO_LOCAL_COMPOSE_ENV" ]; then
    return
  fi

  mkdir -p "$REFLO_LOCAL_STATE_DIR"
  umask 077
  REFLO_LOCAL_RDS_SECRET=$(random_secret)
  REFLO_LOCAL_VECTOR_SECRET=$(random_secret)
  cat >"$REFLO_LOCAL_COMPOSE_ENV" <<EOF
REFLO_LOCAL_RDS_PASSWORD=$REFLO_LOCAL_RDS_SECRET
REFLO_LOCAL_RDS_PORT=${REFLO_LOCAL_RDS_PORT:-55432}
REFLO_LOCAL_VECTOR_PASSWORD=$REFLO_LOCAL_VECTOR_SECRET
REFLO_LOCAL_VECTOR_PORT=${REFLO_LOCAL_VECTOR_PORT:-55433}
EOF
  chmod 600 "$REFLO_LOCAL_COMPOSE_ENV"
}

env_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }' "$REFLO_LOCAL_COMPOSE_ENV"
}

assert_env_value() {
  case "$2" in
    "" | *[!A-Za-z0-9_]* ) fail "$1 contains an unsafe value; remove $REFLO_LOCAL_COMPOSE_ENV and retry" ;;
  esac
}

assert_port() {
  case "$2" in
    "" | *[!0-9]* ) fail "$1 must be a numeric TCP port" ;;
  esac
  if [ "$2" -lt 1024 ] || [ "$2" -gt 65535 ]; then
    fail "$1 must be between 1024 and 65535"
  fi
}

write_app_env() {
  REFLO_LOCAL_RDS_SECRET=$(env_value REFLO_LOCAL_RDS_PASSWORD)
  REFLO_LOCAL_RDS_HOST_PORT=$(env_value REFLO_LOCAL_RDS_PORT)
  REFLO_LOCAL_VECTOR_SECRET=$(env_value REFLO_LOCAL_VECTOR_PASSWORD)
  REFLO_LOCAL_VECTOR_HOST_PORT=$(env_value REFLO_LOCAL_VECTOR_PORT)
  assert_env_value REFLO_LOCAL_RDS_PASSWORD "$REFLO_LOCAL_RDS_SECRET"
  assert_env_value REFLO_LOCAL_VECTOR_PASSWORD "$REFLO_LOCAL_VECTOR_SECRET"
  assert_port REFLO_LOCAL_RDS_PORT "$REFLO_LOCAL_RDS_HOST_PORT"
  assert_port REFLO_LOCAL_VECTOR_PORT "$REFLO_LOCAL_VECTOR_HOST_PORT"

  umask 077
  cat >"$REFLO_LOCAL_APP_ENV" <<EOF
DATABASE_URL=postgresql://reflo:$REFLO_LOCAL_RDS_SECRET@127.0.0.1:$REFLO_LOCAL_RDS_HOST_PORT/reflo?sslmode=disable
TEST_DATABASE_URL=postgresql://reflo:$REFLO_LOCAL_RDS_SECRET@127.0.0.1:$REFLO_LOCAL_RDS_HOST_PORT/reflo?sslmode=disable
REFLO_VECTOR_DATABASE_URL=postgresql://reflo_vectors:$REFLO_LOCAL_VECTOR_SECRET@127.0.0.1:$REFLO_LOCAL_VECTOR_HOST_PORT/reflo_vectors?sslmode=disable
REFLO_POSTGRES_CONTAINER_ID=$REFLO_LOCAL_RDS_CONTAINER
REFLO_POSTGRES_CONTAINER_REWRITE_FROM=127.0.0.1:$REFLO_LOCAL_RDS_HOST_PORT
REFLO_POSTGRES_CONTAINER_REWRITE_TO=127.0.0.1:5432
EOF
  chmod 600 "$REFLO_LOCAL_APP_ENV"
}

ensure_runtime_files() {
  write_compose_env
  write_app_env
}

require_docker_compose() {
  require_command docker "install Docker with the Compose plugin and retry"
  docker compose version >/dev/null 2>&1 || fail "docker compose is required"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is unavailable; start Docker and retry"
}

run_compose() {
  docker compose \
    --project-name "$REFLO_LOCAL_PROJECT" \
    --env-file "$REFLO_LOCAL_COMPOSE_ENV" \
    --file "$REFLO_LOCAL_COMPOSE_FILE" \
    "$@"
}

validate_compose() {
  ensure_runtime_files
  require_docker_compose
  run_compose config --quiet
  echo "Local Compose configuration is valid"
}

start_services() {
  validate_compose
  run_compose up --detach --wait --wait-timeout 120
  echo "Local dependencies are healthy"
  worker_status
}

require_repository_toolchain() {
  require_command node "install Node.js $REFLO_LOCAL_NODE_VERSION and retry"
  require_command corepack "install Node.js $REFLO_LOCAL_NODE_VERSION with Corepack and retry"
  REFLO_LOCAL_ACTUAL_NODE=$(node --version)
  [ "$REFLO_LOCAL_ACTUAL_NODE" = "v$REFLO_LOCAL_NODE_VERSION" ] || \
    fail "node is $REFLO_LOCAL_ACTUAL_NODE; expected v$REFLO_LOCAL_NODE_VERSION"
  REFLO_LOCAL_ACTUAL_PNPM=$(corepack pnpm --version 2>/dev/null) || \
    fail "corepack pnpm is unavailable; expected $REFLO_LOCAL_PNPM_VERSION"
  [ "$REFLO_LOCAL_ACTUAL_PNPM" = "$REFLO_LOCAL_PNPM_VERSION" ] || \
    fail "pnpm is $REFLO_LOCAL_ACTUAL_PNPM; expected $REFLO_LOCAL_PNPM_VERSION"
}

setup_databases() {
  start_services
  require_repository_toolchain
  REFLO_LOCAL_DATABASE_URL=$(env_value REFLO_LOCAL_RDS_PASSWORD)
  REFLO_LOCAL_DATABASE_PORT=$(env_value REFLO_LOCAL_RDS_PORT)
  DATABASE_URL="postgresql://reflo:$REFLO_LOCAL_DATABASE_URL@127.0.0.1:$REFLO_LOCAL_DATABASE_PORT/reflo?sslmode=disable" \
    corepack pnpm --filter @reflo/db db:migrate
  run_compose exec --no-TTY rds \
    psql --set ON_ERROR_STOP=1 --username reflo --dbname reflo \
    <"$REFLO_LOCAL_DEV_RDS_SQL"
  run_compose exec --no-TTY vector \
    psql --set ON_ERROR_STOP=1 --username reflo_vectors --dbname reflo_vectors \
    <"$REFLO_LOCAL_RETRIEVAL_SQL"
  run_compose exec --no-TTY vector \
    psql --set ON_ERROR_STOP=1 --username reflo_vectors --dbname reflo_vectors \
    <"$REFLO_LOCAL_DEV_RETRIEVAL_SQL"
  run_compose exec --no-TTY vector \
    psql --set ON_ERROR_STOP=1 --tuples-only --username reflo_vectors --dbname reflo_vectors \
    --command "SELECT extversion FROM pg_extension WHERE extname = 'vector'; SELECT to_regclass('public.reflo_source_span_embedding_v1'); SELECT to_regclass('public.reflo_source_span_embedding_litellm_dev_v1');"
  echo "Local schemas are ready"
  echo "Application environment: $REFLO_LOCAL_APP_ENV"
}

worker_status() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "SKIPPED ingestion-worker: install development-compatible Podman 5.8.3 or production-pinned 6.0.1 before building packages/ingestion/worker/Containerfile."
  else
    REFLO_LOCAL_PODMAN_VERSION=$(podman --version 2>/dev/null | awk '{ print $3 }')
    case "$REFLO_LOCAL_PODMAN_VERSION" in
      5.8.3 | 6.0.1)
        if [ -z "${REFLO_LOCAL_INGESTION_IMAGE:-}" ]; then
          echo "SKIPPED ingestion-worker: supported local Podman $REFLO_LOCAL_PODMAN_VERSION is installed; set REFLO_LOCAL_INGESTION_IMAGE after the pinned worker build and fixture checks pass."
        elif ! podman image exists "$REFLO_LOCAL_INGESTION_IMAGE" >/dev/null 2>&1; then
          echo "SKIPPED ingestion-worker: REFLO_LOCAL_INGESTION_IMAGE does not resolve to a local Podman image."
        else
          echo "AVAILABLE ingestion-worker: development-compatible Podman $REFLO_LOCAL_PODMAN_VERSION and the local image are present; production remains pinned to 6.0.1 and a signed ClamAV snapshot plus job-scoped mounts are still required per D-GH-8."
        fi
        ;;
      *)
        echo "SKIPPED ingestion-worker: Podman $REFLO_LOCAL_PODMAN_VERSION is installed; the connected development smoke accepts only 5.8.3 or 6.0.1, and production remains pinned to 6.0.1."
        ;;
    esac
  fi

  echo "SKIPPED piper-worker production activation: packages/audio/piper-worker/manifest.json remains blocked; the connected development smoke can use explicit local Python and pinned voice paths, but cannot satisfy its listed license, image, SBOM, capacity, or listening gates."
}

status_services() {
  ensure_runtime_files
  require_docker_compose
  run_compose ps
  worker_status
}

rebuild_services() {
  ensure_runtime_files
  require_docker_compose
  run_compose pull
  run_compose up --detach --force-recreate --wait --wait-timeout 120
  setup_databases
}

teardown_services() {
  ensure_runtime_files
  require_docker_compose
  run_compose down --remove-orphans
  echo "Removed reflo-local containers and network; named data volumes were preserved"
}

reset_services() {
  ensure_runtime_files
  require_docker_compose
  run_compose down --volumes --remove-orphans
  echo "Removed only reflo-local containers, network, and named data volumes"
}

command=${1:-}
case "$command" in
  start) start_services ;;
  setup) setup_databases ;;
  status) status_services ;;
  worker-status) worker_status ;;
  env)
    ensure_runtime_files
    echo "$REFLO_LOCAL_APP_ENV"
    ;;
  validate) validate_compose ;;
  rebuild) rebuild_services ;;
  teardown) teardown_services ;;
  reset) reset_services ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
