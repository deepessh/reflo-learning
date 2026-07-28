#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
commit="$(git -C "$root" rev-parse HEAD)"
target="$root/.artifacts/deployment"
parser_image="reflo-parser:$commit"
native_image="reflo-parser-fc-native:$commit"
bootstrap="$root/packages/ingestion/worker/function/bootstrap"
snapshot="${REFLO_CLAMAV_ADMISSION_DATABASE_DIR:-}"
clamav_updater="docker.io/clamav/clamav@sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c"
scratch="$(mktemp -d)"
container_id=""
native_container_id=""

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$native_container_id" ]]; then
    docker rm --force "$native_container_id" >/dev/null 2>&1 || true
  fi
  chmod -R u+rwX "$scratch" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail "deployment artifacts require an exact Git commit"
fi
if [[ ! -x "$bootstrap" ]]; then
  fail "parser Function Compute bootstrap is absent or not executable"
fi
if [[ -n "$snapshot" && ( "$snapshot" != /* || ! -d "$snapshot" ) ]]; then
  fail "REFLO_CLAMAV_ADMISSION_DATABASE_DIR must name an admitted absolute snapshot directory"
fi

reproducible_zip() {
  local source="$1"
  local destination="$2"
  rm -f "$destination"
  TZ=UTC find "$source" -exec touch -h -t 197001010000 {} +
  (
    cd "$source"
    find . \( -type f -o -type l \) -print0 |
      LC_ALL=C sort -z |
      xargs -0 zip -X -y -q "$destination"
  )
  test -s "$destination"
}

copy_from_parser_image() {
  local source="$1"
  local destination="$2"
  mkdir -p "$destination"
  docker cp "$container_id:$source/." "$destination"
}

cd "$root"
corepack pnpm package
mkdir -p "$target"
rm -f \
  "$target/api.tar.gz" \
  "$target/jobs.zip" \
  "$target/parser.tar" \
  "$target/parser-code.zip" \
  "$target/parser-java-worker-layer.zip" \
  "$target/parser-native-layer.zip" \
  "$target/parser-clamav-snapshot-layer.zip" \
  "$target/manifest.json" \
  "$target/deployment.tfvars.json"

docker run \
  --rm \
  --platform linux/amd64 \
  --network=none \
  --read-only \
  --mount="type=bind,src=$root/.artifacts/api,dst=/input,readonly" \
  --mount="type=bind,src=$target,dst=/output" \
  debian:11.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6 \
  tar \
  --create \
  --gzip \
  --file=/output/api.tar.gz \
  --directory=/input \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  .

reproducible_zip "$root/.artifacts/jobs" "$target/jobs.zip"

# Keep the exact-pinned OCI build as the common local/cloud compiler, but
# export immutable Function Compute archives instead of publishing the image.
docker build \
  --build-arg "REFLO_SOURCE_COMMIT=$commit" \
  --file "$root/packages/ingestion/worker/Containerfile" \
  --tag "$parser_image" \
  "$root/packages/ingestion/worker"
container_id="$(docker create "$parser_image")"
docker build \
  --file "$root/packages/ingestion/worker/FunctionLayerfile" \
  --tag "$native_image" \
  "$root/packages/ingestion/worker"

if [[ -z "$snapshot" ]]; then
  clamav_download="$scratch/clamav-download"
  mkdir -m 0777 "$clamav_download"
  docker pull --platform linux/amd64 "$clamav_updater"
  docker run \
    --rm \
    --pull=never \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --read-only \
    --user=100:101 \
    --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=268435456 \
    --mount="type=bind,src=$clamav_download,dst=/database" \
    --entrypoint=/usr/bin/freshclam \
    "$clamav_updater" \
    --stdout \
    --log=/tmp/freshclam.log \
    --datadir=/database
  snapshot="$(node \
    "$root/scripts/admit-clamav-layer-snapshot.mjs" \
    "$clamav_download")"
fi

code_stage="$scratch/code"
java_stage="$scratch/java-worker"
native_stage="$scratch/native"
snapshot_stage="$scratch/snapshot"
mkdir -p \
  "$code_stage" \
  "$java_stage/reflo" \
  "$native_stage/reflo/native/bin" \
  "$native_stage/reflo/native/lib" \
  "$native_stage/reflo/native/tessdata" \
  "$snapshot_stage/reflo/clamav"

install -m 0555 "$bootstrap" "$code_stage/bootstrap"
copy_from_parser_image "/opt/java/openjdk" "$java_stage/java/openjdk"
docker cp \
  "$container_id:/opt/reflo/worker.jar" \
  "$java_stage/reflo/worker.jar"
docker cp \
  "$container_id:/opt/reflo/worker-manifest.json" \
  "$java_stage/reflo/worker-manifest.json"
install -m 0444 \
  "$root/packages/ingestion/worker/function-manifest.json" \
  "$java_stage/reflo/function-manifest.json"

unzip -Z1 "$java_stage/reflo/worker.jar" >"$scratch/worker-jar-entries.txt"
if ! grep -qx \
  'com/reflo/ingestion/FunctionRuntimeMain.class' \
  "$scratch/worker-jar-entries.txt"; then
  fail "shaded worker JAR does not contain FunctionRuntimeMain"
fi

native_container_id="$(docker create "$native_image")"
docker cp \
  "$native_container_id:/opt/reflo/native/." \
  "$native_stage/reflo/native"
docker rm "$native_container_id" >/dev/null
native_container_id=""

docker run \
  --rm \
  --platform linux/amd64 \
  --network=none \
  --read-only \
  --mount="type=bind,src=$java_stage,dst=/opt,readonly" \
  debian:11.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6 \
  /opt/java/openjdk/bin/java -version
docker run \
  --rm \
  --platform linux/amd64 \
  --network=none \
  --read-only \
  --env=LD_LIBRARY_PATH=/opt/reflo/native/lib \
  --env=TESSDATA_PREFIX=/opt/reflo/native/tessdata \
  --mount="type=bind,src=$native_stage,dst=/opt,readonly" \
  debian:11.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6 \
  /opt/reflo/native/bin/clamscan --version
docker run \
  --rm \
  --platform linux/amd64 \
  --network=none \
  --read-only \
  --env=LD_LIBRARY_PATH=/opt/reflo/native/lib \
  --env=TESSDATA_PREFIX=/opt/reflo/native/tessdata \
  --mount="type=bind,src=$native_stage,dst=/opt,readonly" \
  debian:11.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6 \
  /opt/reflo/native/bin/tesseract --version

node "$root/scripts/validate-clamav-layer-input.mjs" "$snapshot"
snapshot_id="$(basename "$snapshot")"
mkdir -p "$snapshot_stage/reflo/clamav/$snapshot_id"
cp -p "$snapshot"/* "$snapshot_stage/reflo/clamav/$snapshot_id/"
node "$root/scripts/validate-clamav-layer-input.mjs" \
  "$snapshot_stage/reflo/clamav/$snapshot_id"

reproducible_zip "$code_stage" "$target/parser-code.zip"
reproducible_zip \
  "$java_stage" \
  "$target/parser-java-worker-layer.zip"
reproducible_zip "$native_stage" "$target/parser-native-layer.zip"
reproducible_zip \
  "$snapshot_stage" \
  "$target/parser-clamav-snapshot-layer.zip"

node scripts/write-deployment-manifest.mjs \
  "$target/manifest.json" \
  "$commit"
