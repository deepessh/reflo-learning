#!/usr/bin/env sh

set -eu

REFLO_APPS_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REFLO_APPS_COMPOSE_FILE="$REFLO_APPS_ROOT/compose.yaml"
REFLO_APPS_COMPOSE_ENV="$REFLO_APPS_ROOT/.reflo/local-stack/compose.env"
REFLO_APPS_PROJECT=reflo-local
REFLO_APPS_PROFILE=apps

usage() {
  cat <<'EOF'
Usage: scripts/local-apps.sh <command>

Commands:
  up        Build and start databases, setup job, API, jobs, and web.
  status    Show the fixed Reflo application profile state.
  logs      Show bounded recent logs for Reflo application services.
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

up_apps() {
  prepare
  run_compose up --detach --build --wait --wait-timeout 300
  echo "Reflo application profile is ready"
  run_compose ps --all
}

status_apps() {
  prepare
  run_compose ps --all
}

logs_apps() {
  prepare
  run_compose logs --tail 200 app-setup api jobs web
}

down_apps() {
  prepare
  run_compose stop web api jobs
  run_compose rm --force --stop app-setup api jobs web
  echo "Removed only Reflo application-profile containers"
}

reset_apps() {
  prepare
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
  status) status_apps ;;
  logs) logs_apps ;;
  down) down_apps ;;
  reset) reset_apps ;;
  validate) validate_apps ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
