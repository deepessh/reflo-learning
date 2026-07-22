import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodePiperSynthesisProcess } from "./piper-process.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bounded local Piper process", () => {
  it("passes the closed worker contract and returns WAV bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reflo-piper-test-"));
    scratch.push(directory);
    const modelPath = path.join(directory, "voice.onnx");
    const configPath = path.join(directory, "voice.onnx.json");
    const workerPath = path.join(directory, "worker.mjs");
    await writeFile(modelPath, "model");
    await writeFile(configPath, "config");
    await writeFile(workerPath, workerSource());
    const processAdapter = new NodePiperSynthesisProcess({
      configPath,
      configSha256: digest(await readFile(configPath)),
      modelPath,
      modelSha256: digest(await readFile(modelPath)),
      pythonExecutable: process.execPath,
      scratchRoot: path.join(directory, "scratch-root"),
      workerPath,
    });

    const result = await processAdapter.synthesize(
      {
        configPath,
        modelPath,
        narration: "Synthetic narration",
        speakingRate: 1,
      },
      new AbortController().signal,
    );

    expect(result.sampleRateHz).toBe(22_050);
    expect(
      Buffer.from(result.audioBytes).subarray(0, 4).toString("ascii"),
    ).toBe("RIFF");
  });

  it("rejects a request that swaps configured voice paths", async () => {
    const root = path.join(tmpdir(), "reflo-piper-config-test");
    const processAdapter = new NodePiperSynthesisProcess({
      configPath: "/tmp/reflo-piper/config.json",
      configSha256: "a".repeat(64),
      modelPath: "/tmp/reflo-piper/model.onnx",
      modelSha256: "b".repeat(64),
      pythonExecutable: process.execPath,
      scratchRoot: root,
      workerPath: "/tmp/reflo-piper/worker.py",
    });

    await expect(
      processAdapter.synthesize(
        {
          configPath: "/tmp/reflo-piper/other.json",
          modelPath: "/tmp/reflo-piper/model.onnx",
          narration: "Synthetic narration",
          speakingRate: 1,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/invalid local Piper synthesis request/);
  });
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function workerSource(): string {
  return String.raw`import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const request = JSON.parse(readFileSync(0, "utf8"));
if (Object.keys(request).join(",") !== "narration") process.exit(2);
const sampleRate = 22050;
const dataLength = sampleRate * 2;
const bytes = Buffer.alloc(44 + dataLength);
bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WAVE", 8, "ascii"); bytes.write("fmt ", 12, "ascii");
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36, "ascii");
bytes.writeUInt32LE(dataLength, 40); writeFileSync(output, bytes);`;
}
