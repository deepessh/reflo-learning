import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PGVECTOR_IMAGE,
  POSTGRES_IMAGE,
  collectLocalStackViolations,
  validateRepositoryLocalStack,
} from "./check-local-stack.mjs";

const root = process.cwd();
const valid = {
  composeSource: readFileSync(path.join(root, "compose.yaml"), "utf8"),
  gitignoreSource: readFileSync(path.join(root, ".gitignore"), "utf8"),
  scriptSource: readFileSync(path.join(root, "scripts/local-stack.sh"), "utf8"),
};

describe("local supporting-service stack policy", () => {
  it("accepts the checked-in Compose and lifecycle configuration", () => {
    assert.deepEqual(validateRepositoryLocalStack(root), []);
  });

  it("rejects mutable images and non-loopback database exposure", () => {
    const composeSource = valid.composeSource
      .replace(POSTGRES_IMAGE, "postgres:16")
      .replace(PGVECTOR_IMAGE, "pgvector/pgvector:pg16")
      .replace("127.0.0.1:${REFLO_LOCAL_RDS_PORT:-55432}", "0.0.0.0:55432");
    const errors = collectLocalStackViolations({ ...valid, composeSource });

    assert.ok(errors.includes("missing exact RDS image pin"));
    assert.ok(errors.includes("missing exact pgvector image pin"));
    assert.ok(errors.includes("missing loopback-only RDS port"));
    assert.ok(
      errors.includes(
        "every local service image must be immutable by SHA-256 digest",
      ),
    );
  });

  it("rejects decorative emulators and broad Docker cleanup", () => {
    const composeSource = valid.composeSource.replace(
      "  vector:\n",
      "  redis:\n    image: redis:latest\n\n  vector:\n",
    );
    const scriptSource = `${valid.scriptSource}\ndocker system prune\n`;
    const errors = collectLocalStackViolations({
      ...valid,
      composeSource,
      scriptSource,
    });

    assert.ok(
      errors.some((error) =>
        error.includes("only the implemented rds and vector services"),
      ),
    );
    assert.ok(
      errors.includes(
        "unimplemented service emulators must not be added to the local stack",
      ),
    );
    assert.ok(
      errors.includes(
        "local lifecycle commands cannot prune or remove unrelated Docker resources",
      ),
    );
  });
});
