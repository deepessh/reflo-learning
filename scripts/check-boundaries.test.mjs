import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkBoundaries } from "./check-boundaries.mjs";

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "reflo-boundaries-"));
  for (const directory of [
    "apps/api/src",
    "apps/jobs/src",
    "apps/web/src",
    "packages/shared/src",
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }

  try {
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("allows applications to import public shared packages", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "apps/api/src/index.ts"),
      'import "@reflo/shared";\n',
    );
    assert.deepEqual(checkBoundaries(root), []);
  });
});

test("rejects app-to-app package imports", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "apps/api/src/index.ts"),
      'import "@reflo/jobs";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /cannot import application package @reflo\/jobs/,
    );
  });
});

test("rejects app-to-app relative source imports", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "apps/api/src/index.ts"),
      'import "../../jobs/src/index";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /cannot import source from apps\/jobs/,
    );
  });
});

test("rejects shared-package imports from deployable applications", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "packages/shared/src/index.ts"),
      'export * from "@reflo/web";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /cannot import application package @reflo\/web/,
    );
  });
});
