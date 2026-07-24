#!/usr/bin/env sh

set -u

if [ -n "${REFLO_GOVERNANCE_ROOT:-}" ]; then
  REFLO_GOVERNANCE_REPO_ROOT=$REFLO_GOVERNANCE_ROOT
else
  REFLO_GOVERNANCE_REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
fi

REFLO_GOVERNANCE_REQUIREMENTS="$REFLO_GOVERNANCE_REPO_ROOT/scripts/requirements-governance.txt"
REFLO_GOVERNANCE_SELECTED=
REFLO_GOVERNANCE_REMEDIATION=

python_version_is_compatible() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
    >/dev/null 2>&1
}

python_environment_is_compatible() {
  "$1" -c \
    'import sys, yaml; raise SystemExit(0 if sys.version_info >= (3, 10) and yaml.__version__ == "6.0.3" else 1)' \
    >/dev/null 2>&1
}

consider_python() {
  REFLO_GOVERNANCE_CANDIDATE=$1
  if [ ! -x "$REFLO_GOVERNANCE_CANDIDATE" ]; then
    return 1
  fi
  if python_version_is_compatible "$REFLO_GOVERNANCE_CANDIDATE" &&
    [ -z "$REFLO_GOVERNANCE_REMEDIATION" ]; then
    REFLO_GOVERNANCE_REMEDIATION=$REFLO_GOVERNANCE_CANDIDATE
  fi
  if python_environment_is_compatible "$REFLO_GOVERNANCE_CANDIDATE"; then
    REFLO_GOVERNANCE_SELECTED=$REFLO_GOVERNANCE_CANDIDATE
    return 0
  fi
  return 1
}

consider_directories() {
  REFLO_GOVERNANCE_DIRECTORIES=$1
  REFLO_GOVERNANCE_OLD_IFS=$IFS
  IFS=:
  for REFLO_GOVERNANCE_DIRECTORY in $REFLO_GOVERNANCE_DIRECTORIES; do
    if [ -n "$REFLO_GOVERNANCE_DIRECTORY" ] &&
      consider_python "$REFLO_GOVERNANCE_DIRECTORY/python3"; then
      IFS=$REFLO_GOVERNANCE_OLD_IFS
      return 0
    fi
  done
  IFS=$REFLO_GOVERNANCE_OLD_IFS
  return 1
}

if [ -n "${REFLO_GOVERNANCE_PYTHON:-}" ]; then
  consider_python "$REFLO_GOVERNANCE_PYTHON" || true
elif [ -n "${REFLO_GOVERNANCE_PYTHON_DIRS:-}" ]; then
  consider_directories "$REFLO_GOVERNANCE_PYTHON_DIRS" || true
else
  consider_python "$REFLO_GOVERNANCE_REPO_ROOT/.venv-governance/bin/python3" ||
    consider_directories "$PATH" ||
    consider_directories "/usr/local/bin:/opt/homebrew/bin" ||
    true

  if [ -z "$REFLO_GOVERNANCE_SELECTED" ] && command -v pyenv >/dev/null 2>&1; then
    REFLO_GOVERNANCE_PYENV_ROOT=$(pyenv root 2>/dev/null || true)
    if [ -n "$REFLO_GOVERNANCE_PYENV_ROOT" ]; then
      for REFLO_GOVERNANCE_CANDIDATE in \
        "$REFLO_GOVERNANCE_PYENV_ROOT"/versions/*/bin/python3; do
        if consider_python "$REFLO_GOVERNANCE_CANDIDATE"; then
          break
        fi
      done
    fi
  fi
fi

if [ -z "$REFLO_GOVERNANCE_SELECTED" ]; then
  echo "ERROR: governance Python requires Python >=3.10 with PyYAML==6.0.3." >&2
  if [ -n "$REFLO_GOVERNANCE_REMEDIATION" ]; then
    echo "Run: \"$REFLO_GOVERNANCE_REMEDIATION\" -m pip install --requirement \"$REFLO_GOVERNANCE_REQUIREMENTS\"" >&2
  else
    echo "Install Python >=3.10, then run: python3 -m pip install --requirement \"$REFLO_GOVERNANCE_REQUIREMENTS\"" >&2
  fi
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  REFLO_GOVERNANCE_VERSION=$(
    "$REFLO_GOVERNANCE_SELECTED" -c \
      'import sys, yaml; print(f"{sys.version.split()[0]} (PyYAML {yaml.__version__})")'
  )
  echo "governance python: $REFLO_GOVERNANCE_SELECTED ($REFLO_GOVERNANCE_VERSION)"
  exit 0
fi

exec "$REFLO_GOVERNANCE_SELECTED" "$@"
