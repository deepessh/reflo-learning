#!/usr/bin/env sh

set -eu

REFLO_APPS_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_APPS_COMPOSE_FILE="$REFLO_APPS_ROOT/compose.yaml"
REFLO_APPS_COMPOSE_ENV="$REFLO_APPS_ROOT/.reflo/local-stack/compose.env"
REFLO_APPS_RUNTIME_ENV="$REFLO_APPS_ROOT/.reflo/local-stack/runtime.env"
REFLO_APPS_PROJECT=reflo-local
REFLO_APPS_PROFILE=apps

usage() {
  cat <<'EOF'
Usage: scripts/local-apps.sh <command>

Commands:
  up        Build and start databases, setup job, API, jobs, and web.
  ready     Require bounded app, adapter, auth, and worker readiness.
  status    Show the fixed Reflo application profile state.
  logs      Show bounded recent logs. Optional view: activation, activation-failures, or assessment-failures.
  down      Stop and remove only Reflo application-profile containers.
  reset     Remove only the fixed Reflo stack's containers, network, and volumes.
  validate  Validate the application-profile Compose configuration.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_docker_compose() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  docker compose version >/dev/null 2>&1 || fail "docker compose is required"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is unavailable"
}

ensure_runtime_files() {
  "$REFLO_APPS_ROOT/scripts/local-stack.sh" env >/dev/null
  [ -f "$REFLO_APPS_COMPOSE_ENV" ] || fail "local Compose environment is missing"
}

run_compose() {
  docker compose \
    --project-name "$REFLO_APPS_PROJECT" \
    --env-file "$REFLO_APPS_COMPOSE_ENV" \
    --file "$REFLO_APPS_COMPOSE_FILE" \
    --profile "$REFLO_APPS_PROFILE" \
    "$@"
}

prepare() {
  ensure_runtime_files
  require_docker_compose
}

bridge_configured() {
  [ -f "$REFLO_APPS_RUNTIME_ENV" ] &&
    grep -q '^REFLO_DEMO_UPLOAD_PROCESSOR_MODE=local-isolated-ingestion-bridge-v1$' "$REFLO_APPS_RUNTIME_ENV"
}

flow_b_fixture_configured() {
  [ -f "$REFLO_APPS_RUNTIME_ENV" ] &&
    grep -q '^REFLO_FLOW_B_FIXTURE_PROFILE=operator-hosted-connected-demo-v1$' "$REFLO_APPS_RUNTIME_ENV"
}

prepare_flow_b_fixture() {
  if flow_b_fixture_configured; then
    run_compose run --rm --no-deps app-setup \
      node /opt/reflo/api/node_modules/@reflo/db/scripts/prepare-connected-flow-b.mjs
  fi
}

start_bridge() {
  if bridge_configured; then
    require_repository_toolchain
    node "$REFLO_APPS_ROOT/scripts/local-workers.mjs" ready
    corepack pnpm --filter @reflo/ingestion-bridge... build
    node "$REFLO_APPS_ROOT/scripts/local-ingestion-bridge.mjs" start
  fi
}

stop_bridge() {
  if [ -f "$REFLO_APPS_ROOT/.reflo/local-stack/ingestion-bridge.pid" ]; then
    node "$REFLO_APPS_ROOT/scripts/local-ingestion-bridge.mjs" stop
  fi
}

require_repository_toolchain() {
  command -v node >/dev/null 2>&1 || fail "Node.js 24.18.0 is required"
  [ "$(node --version)" = "v24.18.0" ] || fail "Node.js 24.18.0 is required; run scripts/doctor.sh"
}

ready_apps() {
  prepare
  require_repository_toolchain
  run_compose ps --all
  node "$REFLO_APPS_ROOT/scripts/check-operator-demo-readiness.mjs"
  node "$REFLO_APPS_ROOT/scripts/local-workers.mjs" ready
  if bridge_configured; then
    node "$REFLO_APPS_ROOT/scripts/local-ingestion-bridge.mjs" status
  fi
  echo "Reflo operator-hosted connected demo is ready"
}

up_apps() {
  prepare
  run_compose up --detach --build --wait --wait-timeout 300
  prepare_flow_b_fixture
  start_bridge
  ready_apps
}

status_apps() {
  prepare
  run_compose ps --all
  if bridge_configured; then
    node "$REFLO_APPS_ROOT/scripts/local-ingestion-bridge.mjs" status
  fi
}

logs_apps() {
  prepare
  REFLO_LOG_VIEW=${1:-all}
  case "$REFLO_LOG_VIEW" in
    all)
      run_compose logs --since 30m --tail 200 app-setup api jobs web
      if bridge_configured; then
        node "$REFLO_APPS_ROOT/scripts/local-ingestion-bridge.mjs" logs
      fi
      ;;
    activation)
      run_compose logs --since 30m --tail 300 api jobs |
        awk '/activation_operation/'
      ;;
    activation-failures)
      run_compose logs --since 30m --tail 300 api jobs |
        awk '/activation_operation/ && (/failed_permanent/ || /queue_error/)'
      ;;
    assessment-failures)
      run_compose logs --since 30m --tail 300 api |
        awk '/assessment_submission_failed/'
      ;;
    *)
      fail "logs view must be all, activation, activation-failures, or assessment-failures"
      ;;
  esac
}

down_apps() {
  prepare
  stop_bridge
  run_compose down --remove-orphans
  echo "Removed only reflo-local containers and network; named volumes were preserved"
}

reset_apps() {
  prepare
  stop_bridge
  run_compose down --volumes --remove-orphans
  echo "Removed only reflo-local containers, network, and named volumes"
}

validate_apps() {
  prepare
  run_compose config --quiet
  echo "Reflo application-profile Compose configuration is valid"
}

command=${1:-}
case "$command" in
  up) up_apps ;;
  ready) ready_apps ;;
  status) status_apps ;;
  logs) shift; logs_apps "$@" ;;
  down) down_apps ;;
  reset) reset_apps ;;
  validate) validate_apps ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
