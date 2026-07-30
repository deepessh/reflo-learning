import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_CHANGES = 200;
const ACTIONS = new Set(["create", "delete", "no-op", "read", "update"]);

export function summarizeTofuPlan(plan) {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !Array.isArray(plan.resource_changes)
  ) {
    throw new Error("OpenTofu plan JSON is invalid");
  }
  const changes = plan.resource_changes.map((resource) => {
    if (
      typeof resource !== "object" ||
      resource === null ||
      typeof resource.address !== "string" ||
      !/^[A-Za-z0-9_.\-[\]"]{1,512}$/.test(resource.address) ||
      typeof resource.change !== "object" ||
      resource.change === null ||
      !Array.isArray(resource.change.actions) ||
      resource.change.actions.length < 1 ||
      resource.change.actions.length > 2 ||
      !resource.change.actions.every((action) => ACTIONS.has(action))
    ) {
      throw new Error("OpenTofu resource change is invalid");
    }
    return {
      actions: resource.change.actions.join("/"),
      address: resource.address,
    };
  });
  if (changes.length > MAX_CHANGES) {
    throw new Error("OpenTofu plan exceeds the bounded review size");
  }
  changes.sort((left, right) => left.address.localeCompare(right.address));
  const counts = new Map();
  for (const { actions } of changes) {
    counts.set(actions, (counts.get(actions) ?? 0) + 1);
  }
  const lines = [
    "## Sanitized OpenTofu plan review",
    "",
    `Resource changes: ${changes.length}`,
    "",
    ...[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([actions, count]) => `- ${actions}: ${count}`),
    "",
    "| Actions | Resource address |",
    "| --- | --- |",
    ...changes.map(({ actions, address }) => `| ${actions} | \`${address}\` |`),
    "",
    "Values, provider payloads, outputs, and state are intentionally omitted.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const file = process.argv[2];
  if (process.argv.length !== 3 || file === undefined) {
    throw new Error("usage: summarize-tofu-plan.mjs <plan.json>");
  }
  const plan = JSON.parse(await readFile(file, "utf8"));
  process.stdout.write(summarizeTofuPlan(plan));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
