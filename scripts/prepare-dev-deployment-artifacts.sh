#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
commit="$(git -C "$root" rev-parse HEAD)"
target="$root/.artifacts/deployment"

if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deployment artifacts require an exact Git commit" >&2
  exit 1
fi
if ! tar --version 2>/dev/null | head -1 | grep -q 'GNU tar'; then
  echo "deployment packaging requires GNU tar for reproducible archives" >&2
  exit 1
fi

cd "$root"
corepack pnpm package
mkdir -p "$target"

tar --create --gzip \
  --file "$target/api.tar.gz" \
  --directory "$root/.artifacts/api" \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  .

(
  cd "$root/.artifacts/jobs"
  find . -type f -print0 |
    LC_ALL=C sort -z |
    xargs -0 zip -X -q "$target/jobs.zip"
)

docker build \
  --build-arg "REFLO_SOURCE_COMMIT=$commit" \
  --file "$root/packages/ingestion/worker/Containerfile" \
  --tag "reflo-parser:$commit" \
  "$root/packages/ingestion/worker"
docker image save --output "$target/parser.tar" "reflo-parser:$commit"

api_sha="$(sha256sum "$target/api.tar.gz" | cut -d' ' -f1)"
jobs_sha="$(sha256sum "$target/jobs.zip" | cut -d' ' -f1)"
parser_sha="$(sha256sum "$target/parser.tar" | cut -d' ' -f1)"

node scripts/write-deployment-manifest.mjs \
  "$target/manifest.json" \
  "$commit" \
  "$api_sha" \
  "$jobs_sha" \
  "$parser_sha"
