import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  requiredContextsFromRules,
  validateRequiredChecks,
  workflowReportsForEveryPullRequest,
} from "./check-required-checks.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("repository required checks report for documentation-only and code-only PRs", () => {
  assert.deepEqual(validateRequiredChecks(root), []);
  const manifest = JSON.parse(
    readFileSync(path.join(root, ".github/required-checks.json"), "utf8"),
  );
  for (const changedFile of ["AGENTS.md", "apps/api/src/index.ts"]) {
    for (const check of manifest.pullRequestChecks) {
      const workflow = readFileSync(path.join(root, check.workflow), "utf8");
      assert.equal(
        workflowReportsForEveryPullRequest(workflow),
        true,
        `${check.context} must report when ${changedFile} changes`,
      );
    }
  }
});

test("path-filtered pull request workflows are not eligible required checks", () => {
  const source = `name: filtered
on:
  pull_request:
    paths:
      - AGENTS.md
jobs:
  validate:
    runs-on: ubuntu-latest
`;
  assert.equal(workflowReportsForEveryPullRequest(source), false);
});

test("effective ruleset contexts are extracted without duplicates", () => {
  const rules = [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "workspace" },
          { context: "validate" },
          { context: "workspace" },
        ],
      },
    },
  ];
  assert.deepEqual(requiredContextsFromRules(rules), ["validate", "workspace"]);
});
