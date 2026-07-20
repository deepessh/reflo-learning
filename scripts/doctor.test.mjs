import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const doctor = path.join(root, "scripts/doctor.sh");

function executable(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "reflo-doctor-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(directory, "scripts"));
  mkdirSync(path.join(directory, "packages/db/scripts"), { recursive: true });
  writeFileSync(
    path.join(directory, "scripts/toolchain-versions.sh"),
    "REFLO_NODE_VERSION=24.18.0\nREFLO_PNPM_VERSION=10.34.5\nREFLO_POSTGRES_IMAGE=postgres:16.9-bookworm@sha256:test\n",
  );
  executable(
    path.join(directory, "packages/db/scripts/pg-dump-from-container.sh"),
    '#!/usr/bin/env sh\necho "pg_dump (PostgreSQL) 16.9"\n',
  );
  executable(path.join(bin, "node"), '#!/usr/bin/env sh\necho "v24.18.0"\n');
  executable(
    path.join(bin, "corepack"),
    '#!/usr/bin/env sh\n[ "$1 $2" = "pnpm --version" ] && echo "10.34.5"\n',
  );
  executable(
    path.join(bin, "gh"),
    '#!/usr/bin/env sh\necho "gh version test"\n',
  );
  executable(path.join(bin, "docker"), "#!/usr/bin/env sh\nexit 0\n");
  return { bin, directory };
}

test("doctor verifies exact tools and the pinned container client", (t) => {
  const { bin, directory } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync("/bin/sh", [doctor], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      REFLO_DOCTOR_ROOT: directory,
      REFLO_POSTGRES_CONTAINER_ID: "container-test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node version: 24\.18\.0 \(exact\)/);
  assert.match(
    result.stdout,
    /pnpm version: 10\.34\.5 \(exact, via corepack\)/,
  );
  assert.match(result.stdout, /pg_dump \(PostgreSQL\) 16\.9/);
});

test("doctor distinguishes an installed command outside PATH", (t) => {
  const { bin, directory } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const systemBin = path.join(directory, "system-bin");
  mkdirSync(systemBin);
  symlinkSync("/bin/sh", path.join(systemBin, "sh"));
  symlinkSync("/usr/bin/sed", path.join(systemBin, "sed"));
  const result = spawnSync("/bin/sh", [doctor], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: systemBin,
      REFLO_DOCTOR_FALLBACK_DIRS: bin,
      REFLO_DOCTOR_ROOT: directory,
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `gh is installed at ${bin.replaceAll("/", "\\/")}\\/gh but its directory is absent from PATH`,
    ),
  );
  assert.doesNotMatch(result.stderr, /gh is not installed/);
});
