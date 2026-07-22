import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { PiperSynthesisProcess } from "./tts.js";

const MAX_DIAGNOSTIC_BYTES = 2_048;

export interface NodePiperProcessOptions {
  readonly configPath: string;
  readonly configSha256: string;
  readonly modelPath: string;
  readonly modelSha256: string;
  readonly pythonExecutable: string;
  readonly scratchRoot: string;
  readonly workerPath: string;
}

/** Launches the checked-in bounded Piper worker with pre-mounted local assets. */
export class NodePiperSynthesisProcess implements PiperSynthesisProcess {
  readonly #options: NodePiperProcessOptions;

  constructor(options: NodePiperProcessOptions) {
    if (
      !safeAbsoluteFile(options.configPath) ||
      !safeAbsoluteFile(options.modelPath) ||
      !safeAbsoluteFile(options.pythonExecutable) ||
      !safeAbsoluteFile(options.workerPath) ||
      !safeAbsoluteDirectory(options.scratchRoot) ||
      !/^[a-f0-9]{64}$/.test(options.configSha256) ||
      !/^[a-f0-9]{64}$/.test(options.modelSha256)
    ) {
      throw new Error("invalid local Piper process configuration");
    }
    this.#options = options;
  }

  async synthesize(
    request: {
      readonly configPath: string;
      readonly modelPath: string;
      readonly narration: string;
      readonly speakingRate: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly audioBytes: Uint8Array;
    readonly sampleRateHz: 22_050 | 24_000;
  }> {
    if (
      request.configPath !== this.#options.configPath ||
      request.modelPath !== this.#options.modelPath ||
      request.narration.length < 1 ||
      request.narration.length > 100_000 ||
      request.speakingRate < 0.75 ||
      request.speakingRate > 1.5 ||
      signal.aborted
    ) {
      throw new Error("invalid local Piper synthesis request");
    }
    await mkdir(this.#options.scratchRoot, { mode: 0o700, recursive: true });
    const scratch = await mkdtemp(
      path.join(this.#options.scratchRoot, "piper-attempt-"),
    );
    const outputPath = path.join(scratch, "audio.wav");
    try {
      await runPiper(
        this.#options,
        request.narration,
        request.speakingRate,
        outputPath,
        signal,
      );
      const audioBytes = await readFile(outputPath);
      const sampleRateHz = readSampleRate(audioBytes);
      return { audioBytes, sampleRateHz };
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  }
}

function runPiper(
  options: NodePiperProcessOptions,
  narration: string,
  speakingRate: number,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.pythonExecutable,
      [
        options.workerPath,
        "--config",
        options.configPath,
        "--config-sha256",
        options.configSha256,
        "--model",
        options.modelPath,
        "--model-sha256",
        options.modelSha256,
        "--output",
        outputPath,
        "--speaking-rate",
        String(speakingRate),
      ],
      {
        env: {
          CUDA_VISIBLE_DEVICES: "",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let settled = false;
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (exitCode === 0 && closeSignal === null && !signal.aborted) {
        resolve();
        return;
      }
      reject(
        new Error(
          `local Piper worker failed (${signal.aborted ? "aborted" : `exit=${String(exitCode)}`}, stdout=${stdout.byteLength}, stderr=${stderr.byteLength})`,
        ),
      );
    });
    child.stdin.end(JSON.stringify({ narration }));
  });
}

function appendBounded(
  existing: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  if (existing.byteLength >= MAX_DIAGNOSTIC_BYTES) return existing;
  return Buffer.concat([
    existing,
    chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - existing.byteLength),
  ]);
}

function readSampleRate(bytes: Uint8Array): 22_050 | 24_000 {
  if (bytes.byteLength < 44) {
    throw new Error("local Piper output is not a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  if (sampleRate !== 22_050 && sampleRate !== 24_000) {
    throw new Error("local Piper output has an unsupported sample rate");
  }
  return sampleRate;
}

function safeAbsoluteFile(value: string): boolean {
  return (
    path.isAbsolute(value) && !value.includes("..") && !/[\r\n]/.test(value)
  );
}

function safeAbsoluteDirectory(value: string): boolean {
  const resolved = path.resolve(value);
  return (
    safeAbsoluteFile(value) &&
    resolved !== path.parse(resolved).root &&
    path.basename(resolved).length >= 8
  );
}
