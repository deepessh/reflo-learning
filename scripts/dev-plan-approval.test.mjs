import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTofuPlan } from "./summarize-tofu-plan.mjs";
import { findDevPlanApproval } from "./wait-for-dev-plan-approval.mjs";

const identity = {
  commit: "a".repeat(40),
  generatedAt: "2026-07-30T20:00:00.000Z",
  owner: "deepessh",
  planDigest: "b".repeat(64),
};
const body = `<!-- reflo-dev-plan-approval:v1
commit: ${identity.commit}
plan-sha256: ${identity.planDigest}
decision: approved
-->`;

test("accepts only an exact owner approval recorded after plan creation", () => {
  const valid = {
    author_association: "OWNER",
    body,
    created_at: "2026-07-30T20:00:01.000Z",
    user: { login: "deepessh" },
  };
  assert.equal(findDevPlanApproval([valid], identity), valid);
  for (const changed of [
    { ...valid, author_association: "MEMBER" },
    { ...valid, body: `${body}\napproved` },
    { ...valid, created_at: identity.generatedAt },
    { ...valid, user: { login: "another-owner" } },
    { ...valid, body: body.replace(identity.planDigest, "c".repeat(64)) },
  ]) {
    assert.equal(findDevPlanApproval([changed], identity), undefined);
  }
});

test("summarizes only actions and logical addresses", () => {
  const summary = summarizeTofuPlan({
    resource_changes: [
      {
        address: "module.runtime.alicloud_instance.api",
        change: {
          actions: ["create"],
          after: { password: "must-not-appear" },
          before: null,
        },
      },
      {
        address: "module.runtime.alicloud_rocketmq_instance.events",
        change: {
          actions: ["update"],
          after: { private_endpoint: "must-not-appear" },
          before: {},
        },
      },
    ],
  });
  assert.match(summary, /create: 1/);
  assert.match(summary, /update: 1/);
  assert.match(summary, /alicloud_instance\.api/);
  assert.doesNotMatch(summary, /password|private_endpoint|must-not-appear/);
});
