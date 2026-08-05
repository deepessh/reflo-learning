#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FlowBRunRecord } from "./contracts.js";
import {
  FLOW_B_REHEARSAL_RUN_COUNT,
  finalizeFlowBRehearsalRecord,
  verifyFlowBRehearsalSources,
} from "./rehearsal.js";

async function main(): Promise<void> {
  const [outputArgument, ...sourceArguments] = process.argv.slice(2);
  if (
    outputArgument === undefined ||
    sourceArguments.length !== FLOW_B_REHEARSAL_RUN_COUNT
  ) {
    throw new Error(
      `Usage: reflo-flow-b-rehearsal <new-rehearsal-record.json> <run-record.json>... (exactly ${FLOW_B_REHEARSAL_RUN_COUNT} records)`,
    );
  }
  const outputPath = path.resolve(outputArgument);
  const runRecords = await Promise.all(
    sourceArguments.map(async (source) => {
      const value: unknown = JSON.parse(
        await readFile(path.resolve(source), "utf8"),
      );
      return value as FlowBRunRecord;
    }),
  );
  const record = finalizeFlowBRehearsalRecord(runRecords);
  verifyFlowBRehearsalSources(record, runRecords);
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.info(
    [
      `${record.recordVersion}: passed`,
      `runs=${record.runCount}`,
      `failures=${record.observedFailureCount}`,
      `maximumMs=${record.duration.maximumMs}`,
      "qualificationClaims=false",
      `record=${record.recordDigest}`,
    ].join(" "),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Flow B rehearsal record generation failed",
  );
  process.exitCode = 1;
});
