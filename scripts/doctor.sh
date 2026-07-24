#!/usr/bin/env sh

set -u

if [ -n "${REFLO_DOCTOR_ROOT:-}" ]; then
  REFLO_DOCTOR_REPO_ROOT=$REFLO_DOCTOR_ROOT
else
  REFLO_DOCTOR_REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
fi

REFLO_DOCTOR_MANIFEST="$REFLO_DOCTOR_REPO_ROOT/scripts/toolchain-versions.sh"
if [ ! -f "$REFLO_DOCTOR_MANIFEST" ]; then
  echo "toolchain manifest: missing at $REFLO_DOCTOR_MANIFEST" >&2
  exit 1
fi

# shellcheck source=toolchain-versions.sh
. "$REFLO_DOCTOR_MANIFEST"

REFLO_DOCTOR_ERRORS=0
REFLO_DOCTOR_WARNINGS=0
REFLO_DOCTOR_FALLBACKS=${REFLO_DOCTOR_FALLBACK_DIRS:-/usr/local/bin:/opt/homebrew/bin}

record_error() {
  echo "ERROR: $*" >&2
  REFLO_DOCTOR_ERRORS=$((REFLO_DOCTOR_ERRORS + 1))
}

record_warning() {
  echo "WARN: $*" >&2
  REFLO_DOCTOR_WARNINGS=$((REFLO_DOCTOR_WARNINGS + 1))
}

report_node_activation() {
  REFLO_DOCTOR_NODE_DIRECTORY=$1
  REFLO_DOCTOR_PINNED_NODE="$REFLO_DOCTOR_NODE_DIRECTORY/node"
  echo "node $REFLO_NODE_VERSION installed: $REFLO_DOCTOR_PINNED_NODE"
  printf 'activate pinned node: export PATH="%s:$PATH"\n' "$REFLO_DOCTOR_NODE_DIRECTORY"
}

find_pinned_node() {
  if [ -n "${REFLO_DOCTOR_NODE_DIRS:-}" ]; then
    REFLO_DOCTOR_NODE_SEARCH_DIRS=$REFLO_DOCTOR_NODE_DIRS
  else
    REFLO_DOCTOR_NODE_SEARCH_DIRS=$REFLO_DOCTOR_FALLBACKS
    if [ -n "${NVM_DIR:-}" ]; then
      REFLO_DOCTOR_NODE_SEARCH_DIRS="$NVM_DIR/versions/node/v$REFLO_NODE_VERSION/bin:$REFLO_DOCTOR_NODE_SEARCH_DIRS"
    fi
    if [ -n "${VOLTA_HOME:-}" ]; then
      REFLO_DOCTOR_NODE_SEARCH_DIRS="$VOLTA_HOME/bin:$REFLO_DOCTOR_NODE_SEARCH_DIRS"
    fi
  fi

  REFLO_DOCTOR_NODE_OLD_IFS=$IFS
  IFS=:
  for REFLO_DOCTOR_NODE_DIRECTORY in $REFLO_DOCTOR_NODE_SEARCH_DIRS; do
    REFLO_DOCTOR_NODE_CANDIDATE="$REFLO_DOCTOR_NODE_DIRECTORY/node"
    if [ -x "$REFLO_DOCTOR_NODE_CANDIDATE" ]; then
      REFLO_DOCTOR_NODE_CANDIDATE_VERSION=$(
        "$REFLO_DOCTOR_NODE_CANDIDATE" --version 2>/dev/null || true
      )
      REFLO_DOCTOR_NODE_CANDIDATE_VERSION=${REFLO_DOCTOR_NODE_CANDIDATE_VERSION#v}
      if [ "$REFLO_DOCTOR_NODE_CANDIDATE_VERSION" = "$REFLO_NODE_VERSION" ]; then
        IFS=$REFLO_DOCTOR_NODE_OLD_IFS
        report_node_activation "$REFLO_DOCTOR_NODE_DIRECTORY"
        return 0
      fi
    fi
  done
  IFS=$REFLO_DOCTOR_NODE_OLD_IFS
  return 1
}

resolve_command() {
  REFLO_DOCTOR_COMMAND=$1
  REFLO_DOCTOR_RESOLVED=$(command -v "$REFLO_DOCTOR_COMMAND" 2>/dev/null || true)
  REFLO_DOCTOR_ON_PATH=true
  if [ -n "$REFLO_DOCTOR_RESOLVED" ]; then
    return 0
  fi

  REFLO_DOCTOR_ON_PATH=false
  REFLO_DOCTOR_OLD_IFS=$IFS
  IFS=:
  for REFLO_DOCTOR_DIRECTORY in $REFLO_DOCTOR_FALLBACKS; do
    if [ -x "$REFLO_DOCTOR_DIRECTORY/$REFLO_DOCTOR_COMMAND" ]; then
      REFLO_DOCTOR_RESOLVED="$REFLO_DOCTOR_DIRECTORY/$REFLO_DOCTOR_COMMAND"
      IFS=$REFLO_DOCTOR_OLD_IFS
      return 0
    fi
  done
  IFS=$REFLO_DOCTOR_OLD_IFS
  return 1
}

check_required_command() {
  REFLO_DOCTOR_NAME=$1
  if ! resolve_command "$REFLO_DOCTOR_NAME"; then
    record_error "$REFLO_DOCTOR_NAME is not installed"
    return 1
  fi
  if [ "$REFLO_DOCTOR_ON_PATH" = false ]; then
    record_error "$REFLO_DOCTOR_NAME is installed at $REFLO_DOCTOR_RESOLVED but its directory is absent from PATH"
  else
    echo "$REFLO_DOCTOR_NAME: $REFLO_DOCTOR_RESOLVED"
  fi
  return 0
}

echo "Reflo toolchain doctor"
echo "repository: $REFLO_DOCTOR_REPO_ROOT"

if check_required_command node; then
  REFLO_DOCTOR_NODE=$REFLO_DOCTOR_RESOLVED
  REFLO_DOCTOR_ACTUAL_NODE=$("$REFLO_DOCTOR_NODE" --version 2>/dev/null || true)
  REFLO_DOCTOR_ACTUAL_NODE=${REFLO_DOCTOR_ACTUAL_NODE#v}
  if [ "$REFLO_DOCTOR_ACTUAL_NODE" != "$REFLO_NODE_VERSION" ]; then
    record_error "node is $REFLO_DOCTOR_ACTUAL_NODE; expected exactly $REFLO_NODE_VERSION from .nvmrc"
    find_pinned_node || true
  else
    echo "node version: $REFLO_DOCTOR_ACTUAL_NODE (exact)"
  fi
fi

if check_required_command corepack; then
  REFLO_DOCTOR_COREPACK=$REFLO_DOCTOR_RESOLVED
  REFLO_DOCTOR_ACTUAL_PNPM=$("$REFLO_DOCTOR_COREPACK" pnpm --version 2>/dev/null || true)
  if [ "$REFLO_DOCTOR_ACTUAL_PNPM" != "$REFLO_PNPM_VERSION" ]; then
    record_error "corepack pnpm is ${REFLO_DOCTOR_ACTUAL_PNPM:-unavailable}; expected exactly $REFLO_PNPM_VERSION"
  else
    echo "pnpm version: $REFLO_DOCTOR_ACTUAL_PNPM (exact, via corepack)"
  fi
fi

if check_required_command gh; then
  REFLO_DOCTOR_GH=$REFLO_DOCTOR_RESOLVED
  REFLO_DOCTOR_GH_VERSION=$("$REFLO_DOCTOR_GH" --version 2>/dev/null | sed -n '1p')
  echo "github cli: ${REFLO_DOCTOR_GH_VERSION:-version unavailable}"
fi

REFLO_DOCTOR_SCHEMA_WRAPPER="$REFLO_DOCTOR_REPO_ROOT/packages/db/scripts/pg-dump-from-container.sh"
if [ ! -x "$REFLO_DOCTOR_SCHEMA_WRAPPER" ]; then
  record_error "canonical PostgreSQL client wrapper is missing or not executable: $REFLO_DOCTOR_SCHEMA_WRAPPER"
elif [ -n "${REFLO_POSTGRES_CONTAINER_ID:-}" ]; then
  if resolve_command docker; then
    REFLO_DOCTOR_DOCKER=$REFLO_DOCTOR_RESOLVED
    REFLO_DOCTOR_DOCKER_DIR=$(dirname "$REFLO_DOCTOR_DOCKER")
    REFLO_DOCTOR_PG_VERSION=$(PATH="$REFLO_DOCTOR_DOCKER_DIR:$PATH" "$REFLO_DOCTOR_SCHEMA_WRAPPER" --version 2>/dev/null || true)
    if [ -z "$REFLO_DOCTOR_PG_VERSION" ]; then
      record_error "digest-pinned PostgreSQL container $REFLO_POSTGRES_CONTAINER_ID is unavailable"
    else
      echo "postgres client: $REFLO_DOCTOR_PG_VERSION via $REFLO_POSTGRES_IMAGE"
    fi
  else
    record_error "docker is not installed; cannot reach the configured PostgreSQL service container"
  fi
else
  record_warning "exact PostgreSQL validation is CI-only until REFLO_POSTGRES_CONTAINER_ID names a container using $REFLO_POSTGRES_IMAGE"
fi

if [ "$REFLO_DOCTOR_ERRORS" -ne 0 ]; then
  echo "Doctor found $REFLO_DOCTOR_ERRORS error(s) and $REFLO_DOCTOR_WARNINGS warning(s)." >&2
  exit 1
fi

echo "Doctor passed with $REFLO_DOCTOR_WARNINGS warning(s)."
