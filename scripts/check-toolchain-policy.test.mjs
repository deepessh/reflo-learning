import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkToolchainPolicy } from "./check-toolchain-policy.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("repository toolchain pins and generated-file diagnostics stay aligned", () => {
  assert.deepEqual(checkToolchainPolicy(root), []);
});

test("toolchain policy reports Turbo environment drift", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "reflo-toolchain-policy-"));
  try {
    for (const relative of [
      ".nvmrc",
      ".github/workflows/ci.yml",
      "package.json",
      "turbo.json",
      "scripts/toolchain-versions.sh",
      "scripts/doctor.sh",
      "packages/db/package.json",
      "packages/db/README.md",
      "packages/db/scripts/dump-schema-from-container.sh",
      "packages/db/scripts/pg-dump-from-container.sh",
      "packages/db/test/schema.test.mjs",
    ]) {
      const target = path.join(fixture, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, relative), target);
    }
    const turboPath = path.join(fixture, "turbo.json");
    const altered = readFileSync(turboPath, "utf8").replace(
      '        "REFLO_POSTGRES_CONTAINER_ID",\n',
      "",
    );
    writeFileSync(turboPath, altered);
    assert.match(
      checkToolchainPolicy(fixture).join("\n"),
      /turbo test env must pass REFLO_POSTGRES_CONTAINER_ID/,
    );

    const rewriteAltered = readFileSync(
      path.join(root, "turbo.json"),
      "utf8",
    ).replace('        "REFLO_POSTGRES_CONTAINER_REWRITE_FROM",\n', "");
    writeFileSync(turboPath, rewriteAltered);
    assert.match(
      checkToolchainPolicy(fixture).join("\n"),
      /turbo test env must pass REFLO_POSTGRES_CONTAINER_REWRITE_FROM/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
