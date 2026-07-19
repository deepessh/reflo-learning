#!/usr/bin/env bash

set -euo pipefail

WORK_LABEL="work:claimed"
IDENTITY_DIR=".reflo"
IDENTITY_FILE="$IDENTITY_DIR/identity"
CURRENT_ISSUE_FILE="$IDENTITY_DIR/current-issue"
LOCK_DIR="$IDENTITY_DIR/work-item.lock"
LOCK_HELD=0

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/work-item.sh pick
  scripts/work-item.sh release --handoff "<message>"
EOF
  exit 64
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

release_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

acquire_lock() {
  mkdir -p "$IDENTITY_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    LOCK_HELD=1
    trap release_lock EXIT
    trap 'exit 130' INT TERM
    return
  fi

  local owner_pid=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner_pid=$(sed -n '1p' "$LOCK_DIR/pid")
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    die "another work-item operation is active in this worktree (pid $owner_pid)"
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || die "stale work-item lock could not be cleared: $LOCK_DIR"
  mkdir "$LOCK_DIR" || die "could not acquire work-item lock"
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  LOCK_HELD=1
  trap release_lock EXIT
  trap 'exit 130' INT TERM
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

preflight() {
  require_command git
  require_command gh
  require_command jq
  gh --version >/dev/null
  gh auth status -h github.com >/dev/null 2>&1 || true
  if ! gh api user --jq .login >/dev/null 2>&1; then
    die "GitHub API access is unavailable; retry with approved network access before diagnosing authentication"
  fi
}

ensure_identity() {
  local repo_identity host_name worktree_root digest generated
  if [[ -f "$IDENTITY_FILE" ]]; then
    AGENT_LABEL=$(sed -n '1p' "$IDENTITY_FILE")
    [[ "$AGENT_LABEL" =~ ^agent:wt-[0-9a-f]{20}$ ]] || die "invalid cached worktree identity: $IDENTITY_FILE"
    export AGENT_LABEL
    return
  fi

  repo_identity=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  host_name=$(hostname)
  worktree_root=$(pwd -P)
  digest=$(printf '%s\n%s\n%s\n' "$repo_identity" "$host_name" "$worktree_root" | sha256_stream)
  generated="agent:wt-${digest:0:20}"
  printf '%s\n' "$generated" >"$IDENTITY_FILE"
  AGENT_LABEL="$generated"
  export AGENT_LABEL
}

label_exists() {
  local name="$1"
  gh label list --limit 1000 --json name | jq -e --arg name "$name" 'any(.[]; .name == $name)' >/dev/null
}

ensure_label() {
  local name="$1" color="$2" description="$3"
  if label_exists "$name"; then
    return
  fi
  if ! gh label create "$name" --color "$color" --description "$description" >/dev/null 2>&1; then
    label_exists "$name" || die "could not create required label: $name"
  fi
}

ensure_claim_labels() {
  ensure_label "$WORK_LABEL" "1D76DB" "Work item currently claimed by a Reflo worktree"
  ensure_label "$AGENT_LABEL" "C5DEF5" "Claim owner derived from a Reflo worktree fingerprint"
}

current_milestone() {
  local today="${REFLO_WORK_ITEM_TODAY:-$(date +%F)}"
  case "$today" in
    2026-07-17|2026-07-18|2026-07-19|2026-07-20|2026-07-21|2026-07-22|2026-07-23) printf 'W1\n' ;;
    2026-07-24|2026-07-25|2026-07-26|2026-07-27|2026-07-28|2026-07-29|2026-07-30) printf 'W2\n' ;;
    2026-07-31|2026-08-01|2026-08-02|2026-08-03|2026-08-04|2026-08-05|2026-08-06|2026-08-07) printf 'W3\n' ;;
    *) die "no active sprint milestone for $today; ask a human which queue is active" ;;
  esac
}

issue_has_label() {
  local issue_json="$1" name="$2"
  printf '%s' "$issue_json" | jq -e --arg name "$name" 'any(.labels[]; .name == $name)' >/dev/null
}

remote_claims_for_identity() {
  gh issue list --state all --label "$AGENT_LABEL" --limit 1000 \
    --json number,title,url,state,labels
}

write_current_issue() {
  printf '%s\n' "$1" >"$CURRENT_ISSUE_FILE"
}

find_remote_claim() {
  local claims count
  claims=$(remote_claims_for_identity)
  count=$(printf '%s' "$claims" | jq 'length')
  if [[ "$count" -gt 1 ]]; then
    printf '%s' "$claims" | jq -r '"#\(.number) \(.url)"' >&2
    die "worktree identity has multiple claims"
  fi
  if [[ "$count" -eq 1 ]]; then
    printf '%s' "$claims" | jq -r '.[0].number'
  fi
}

print_issue() {
  local number="$1" prefix="$2" issue_json
  issue_json=$(gh issue view "$number" --json number,title,url,state)
  printf '%s #%s: %s\n%s\n' \
    "$prefix" \
    "$(printf '%s' "$issue_json" | jq -r .number)" \
    "$(printf '%s' "$issue_json" | jq -r .title)" \
    "$(printf '%s' "$issue_json" | jq -r .url)"
}

dependency_numbers() {
  local body="$1" lines count line values
  lines=$(printf '%s\n' "$body" | awk '/^Depends on:/{print}')
  if [[ -z "$lines" ]]; then
    if printf '%s\n' "$body" | grep -q 'Depends on'; then
      return 2
    fi
    return 0
  fi
  count=$(printf '%s\n' "$lines" | awk 'END {print NR}')
  [[ "$count" -eq 1 ]] || return 2
  line=$(printf '%s\n' "$lines" | sed -n '1p')
  [[ "$line" =~ ^Depends\ on:\ \#[0-9]+(,\ \#[0-9]+)*$ ]] || return 2
  values=${line#Depends on: }
  printf '%s\n' "$values" | tr ',' '\n' | tr -d ' #'
}

dependencies_closed() {
  local number="$1" body="$2" dependencies dependency state
  if ! dependencies=$(dependency_numbers "$body"); then
    printf 'Skipping #%s: malformed dependency declaration\n' "$number" >&2
    return 1
  fi
  while IFS= read -r dependency; do
    [[ -n "$dependency" ]] || continue
    if ! state=$(gh issue view "$dependency" --json state --jq .state 2>/dev/null); then
      printf 'Skipping #%s: dependency #%s is inaccessible\n' "$number" "$dependency" >&2
      return 1
    fi
    if [[ "$state" != "CLOSED" ]]; then
      return 1
    fi
  done <<<"$dependencies"
  return 0
}

remove_label_if_present() {
  local number="$1" label="$2" issue_json
  issue_json=$(gh issue view "$number" --json labels)
  if issue_has_label "$issue_json" "$label"; then
    gh issue edit "$number" --remove-label "$label" >/dev/null
  fi
}

claim_candidate() {
  local number="$1" issue_json agent_labels events winner
  gh api "repos/{owner}/{repo}/issues/$number/labels" --method POST \
    -f "labels[]=$WORK_LABEL" -f "labels[]=$AGENT_LABEL" --silent

  issue_json=$(gh issue view "$number" --json labels)
  agent_labels=$(printf '%s' "$issue_json" | jq '[.labels[].name | select(startswith("agent:wt-"))]')
  if ! printf '%s' "$agent_labels" | jq -e --arg ours "$AGENT_LABEL" 'index($ours) != null' >/dev/null; then
    die "claim label was not present after claiming #$number"
  fi
  if [[ $(printf '%s' "$agent_labels" | jq 'length') -eq 1 ]]; then
    write_current_issue "$number"
    return 0
  fi

  events=$(gh api "repos/{owner}/{repo}/issues/$number/events?per_page=100" --paginate --slurp)
  winner=$(printf '%s' "$events" | jq -r --argjson current "$agent_labels" '
    add as $events
    | [
        $current[] as $name
        | ($events
            | map(select(.event == "labeled" and .label.name == $name))
            | sort_by(.created_at, .id)
            | last) as $event
        | select($event != null)
        | {name: $name, created_at: $event.created_at, id: $event.id}
      ]
    | sort_by(.created_at, .id)
    | .[0].name // empty
  ')
  [[ -n "$winner" ]] || die "could not resolve concurrent claims for #$number"
  if [[ "$winner" == "$AGENT_LABEL" ]]; then
    write_current_issue "$number"
    return 0
  fi

  remove_label_if_present "$number" "$AGENT_LABEL"
  return 10
}

pick_work() {
  local existing milestone issues candidates number body result
  existing=$(find_remote_claim)
  if [[ -n "$existing" ]]; then
    write_current_issue "$existing"
    print_issue "$existing" "Existing claim"
    return 0
  fi
  rm -f "$CURRENT_ISSUE_FILE"

  milestone=$(current_milestone)
  issues=$(gh issue list --milestone "$milestone" --state open --limit 1000 \
    --json number,title,url,body,assignees,labels)
  candidates=$(printf '%s' "$issues" | jq -r '
    [
      .[]
      | select((.assignees | length) == 0)
      | [.labels[].name] as $labels
      | select(($labels | index("blocked")) == null)
      | select(($labels | index("needs-human")) == null)
      | select(($labels | index("work:claimed")) == null)
      | select(([$labels[] | select(startswith("agent:wt-"))] | length) == 0)
      | {number: .number, p1: (($labels | index("p1")) != null)}
    ]
    | sort_by(.p1, .number)
    | .[].number
  ')

  while IFS= read -r number; do
    [[ -n "$number" ]] || continue
    body=$(printf '%s' "$issues" | jq -r --argjson number "$number" '.[] | select(.number == $number) | .body')
    dependencies_closed "$number" "$body" || continue
    result=0
    claim_candidate "$number" || result=$?
    if [[ "$result" -eq 0 ]]; then
      print_issue "$number" "Claimed"
      return 0
    fi
    if [[ "$result" -ne 10 ]]; then
      return "$result"
    fi
  done <<<"$candidates"

  printf 'No dependency-ready work is available in %s.\n' "$milestone" >&2
  return 2
}

latest_agent_label_event_id() {
  local number="$1" events
  events=$(gh api "repos/{owner}/{repo}/issues/$number/events?per_page=100" --paginate --slurp)
  printf '%s' "$events" | jq -r --arg label "$AGENT_LABEL" '
    add
    | map(select(.event == "labeled" and .label.name == $label))
    | sort_by(.created_at, .id)
    | last
    | .id // empty
  '
}

handoff_marker() {
  local number="$1" claim_event_id="$2" thread_id="$3" handoff="$4" digest
  digest=$(printf '%s\n%s\n%s\n%s\n%s\n' "$AGENT_LABEL" "$number" "$claim_event_id" "$thread_id" "$handoff" | sha256_stream)
  printf '<!-- reflo-work-release:%s -->\n' "${digest:0:20}"
}

handoff_exists() {
  local number="$1" marker="$2" comments
  comments=$(gh api "repos/{owner}/{repo}/issues/$number/comments?per_page=100" --paginate --slurp)
  printf '%s' "$comments" | jq -e --arg marker "$marker" 'add | any(.[]; .body | contains($marker))' >/dev/null
}

release_work() {
  local handoff="$1" remote cached="" number issue_json claim_event_id thread_id marker comment active=0
  remote=$(find_remote_claim)
  if [[ -f "$CURRENT_ISSUE_FILE" ]]; then
    cached=$(sed -n '1p' "$CURRENT_ISSUE_FILE")
    [[ "$cached" =~ ^[0-9]+$ ]] || die "invalid cached issue number: $CURRENT_ISSUE_FILE"
  fi
  if [[ -n "$remote" && -n "$cached" && "$remote" != "$cached" ]]; then
    die "cached issue #$cached conflicts with remote claim #$remote"
  fi
  number=${remote:-$cached}
  [[ -n "$number" ]] || die "this worktree has no claim to release"

  issue_json=$(gh issue view "$number" --json number,title,url,state,labels)
  if issue_has_label "$issue_json" "$AGENT_LABEL"; then
    active=1
  elif issue_has_label "$issue_json" "$WORK_LABEL"; then
    die "issue #$number is claimed but no longer owned by $AGENT_LABEL"
  fi

  claim_event_id=$(latest_agent_label_event_id "$number")
  [[ -n "$claim_event_id" ]] || die "issue #$number has no claim event for $AGENT_LABEL"
  thread_id=${CODEX_THREAD_ID:-unavailable}
  marker=$(handoff_marker "$number" "$claim_event_id" "$thread_id" "$handoff")
  if ! handoff_exists "$number" "$marker"; then
    [[ "$active" -eq 1 ]] || die "stale local claim for #$number has no matching release handoff"
    comment=$(printf '%s\n\nCodex-Thread-ID: %s\n%s' "$handoff" "$thread_id" "$marker")
    gh issue comment "$number" --body "$comment" >/dev/null
  fi

  remove_label_if_present "$number" "$WORK_LABEL"
  remove_label_if_present "$number" "$AGENT_LABEL"
  rm -f "$CURRENT_ISSUE_FILE"
  print_issue "$number" "Released"
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || usage

  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this command inside a Git worktree"
  cd "$ROOT"
  acquire_lock
  preflight
  ensure_identity
  ensure_claim_labels

  case "$command" in
    pick)
      [[ "$#" -eq 1 ]] || usage
      pick_work
      ;;
    release)
      [[ "$#" -eq 3 && "$2" == "--handoff" && -n "$3" ]] || usage
      release_work "$3"
      ;;
    *) usage ;;
  esac
}

main "$@"
