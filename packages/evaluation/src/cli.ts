#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import type { DatasetManifest, GateRun } from "./contracts.js";
import {
  canonicalJson,
  createEvidenceBundle,
  githubSafeSummary,
} from "./evidence.js";
import { scoreGate } from "./scoring.js";

const [, , inputPath, outputPath] = process.argv;
if (inputPath === undefined || outputPath === undefined) {
  throw new Error("usage: reflo-evaluate <input.json> <bundle.json>");
}

const parsed = JSON.parse(await readFile(inputPath, "utf8")) as {
  readonly manifest?: DatasetManifest;
  readonly run?: GateRun;
};
if (parsed.manifest === undefined || parsed.run === undefined) {
  throw new Error("input must contain manifest and run");
}
const gateResult = scoreGate(parsed.manifest, parsed.run);
const bundle = createEvidenceBundle(parsed.manifest, parsed.run, gateResult);
await writeFile(outputPath, `${canonicalJson(bundle)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(`${githubSafeSummary(bundle)}\n`);
