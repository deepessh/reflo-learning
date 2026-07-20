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

test("rejects raw database clients from applications", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "apps/jobs/src/index.ts"),
      'import pg from "pg";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /raw database client pg is only allowed in packages\/db/,
    );
  });
});

test("rejects raw database clients from other shared packages", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "packages/shared/src/index.ts"),
      'import postgres from "postgres";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /raw database client postgres is only allowed in packages\/db/,
    );
  });
});

test("allows database clients inside the owning db package", () => {
  withFixture((root) => {
    mkdirSync(path.join(root, "packages/db/test"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/db/test/schema.test.mjs"),
      'import pg from "pg";\n',
    );
    assert.deepEqual(checkBoundaries(root), []);
  });
});

test("rejects direct model provider SDK imports from feature code", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "apps/api/src/index.ts"),
      'import OpenAI from "openai";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /model provider SDK openai is only allowed in packages\/model-router\/src\/adapters/,
    );
  });
});

test("rejects direct model provider SDK imports from shared domain packages", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "packages/shared/src/index.ts"),
      'import "@alicloud/dashscope";\n',
    );
    assert.match(
      checkBoundaries(root)[0],
      /model provider SDK @alicloud\/dashscope is only allowed/,
    );
  });
});

test("allows model provider SDK imports only inside model adapter modules", () => {
  withFixture((root) => {
    const adapterDirectory = path.join(
      root,
      "packages/model-router/src/adapters",
    );
    mkdirSync(adapterDirectory, { recursive: true });
    writeFileSync(
      path.join(adapterDirectory, "qwen.ts"),
      'import "@alicloud/dashscope";\n',
    );
    assert.deepEqual(checkBoundaries(root), []);
  });
});
