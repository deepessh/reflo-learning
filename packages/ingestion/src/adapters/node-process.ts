import { spawn } from "node:child_process";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";

export class NodeProcessRunner implements ProcessRunnerPort {
  run(
    executable: string,
    args: readonly string[],
    options: { readonly maxOutputBytes: number; readonly timeoutMs: number },
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk, options.maxOutputBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk, options.maxOutputBytes);
      });
      child.on("error", () => {
        clearTimeout(timeout);
        resolve({
          exitCode: 127,
          signal: null,
          stderr: "",
          stdout: "",
          timedOut: false,
        });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          signal,
          stderr: stderr.toString("utf8"),
          stdout: stdout.toString("utf8"),
          timedOut,
        });
      });
    });
  }
}

function appendBounded(
  existing: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maximum: number,
): Buffer<ArrayBufferLike> {
  if (existing.byteLength >= maximum) {
    return existing;
  }
  return Buffer.concat([
    existing,
    chunk.subarray(0, maximum - existing.byteLength),
  ]);
}
