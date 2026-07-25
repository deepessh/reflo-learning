#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runFlowBBrowserAssertion } from "./browser-runner.js";
import { readFlowBAssertionConfig } from "./contracts.js";

async function main(): Promise<void> {
  const outputArgument = process.argv[2];
  if (outputArgument === undefined || process.argv.length !== 3) {
    throw new Error(
      "Usage: reflo-flow-b-assert <new-sanitized-run-record.json>",
    );
  }
  const outputPath = path.resolve(outputArgument);
  const record = await runFlowBBrowserAssertion(
    readFlowBAssertionConfig(process.env),
  );
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.info(
    [
      `${record.assertionVersion}: passed`,
      `durationMs=${record.durationMs}`,
      `run=${record.runId}`,
      `record=${record.recordDigest}`,
    ].join(" "),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Flow B browser assertion failed",
  );
  process.exitCode = 1;
});
