import path from "node:path";

import type { ProcessRunnerPort } from "../ports.js";

const CLAMAV_SCANNER_MEMORY_BYTES = 1_024 * 1_024 * 1_024;
const FAILED_PROCESS = Object.freeze({
  exitCode: 127,
  signal: null,
  stderr: "",
  stdout: "",
  timedOut: false,
});

export interface PodmanClamAvConfiguration {
  readonly databaseDirectory: string;
  readonly imageReference: string;
}

/** Confines the two exact ClamAV commands used by the trusted supervisor. */
export class PodmanClamAvProcessRunner implements ProcessRunnerPort {
  readonly #configuration: PodmanClamAvConfiguration;

  constructor(
    configuration: PodmanClamAvConfiguration,
    private readonly runner: ProcessRunnerPort,
  ) {
    if (
      !isSafeAbsolutePath(configuration.databaseDirectory) ||
      !/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(
        configuration.imageReference,
      )
    ) {
      throw new Error("invalid Podman ClamAV configuration");
    }
    this.#configuration = configuration;
  }

  run(
    executable: string,
    args: readonly string[],
    options: { readonly maxOutputBytes: number; readonly timeoutMs: number },
  ) {
    if (executable !== "clamscan" && executable !== "sigtool") {
      return Promise.resolve(FAILED_PROCESS);
    }
    if (executable === "sigtool") {
      if (args.length === 1 && args[0] === "--version") {
        return this.runner.run(
          "podman",
          [
            ...this.#baseArguments(),
            "--entrypoint=/usr/bin/sigtool",
            this.#configuration.imageReference,
            "--version",
          ],
          options,
        );
      }
      const databasePath = args[1];
      if (
        args.length !== 2 ||
        args[0] !== "--info" ||
        databasePath === undefined ||
        path.dirname(databasePath) !== this.#configuration.databaseDirectory ||
        !/^(?:bytecode|daily|main)\.(?:cld|cvd)$/.test(
          path.basename(databasePath),
        )
      ) {
        return Promise.resolve(FAILED_PROCESS);
      }
      return this.runner.run(
        "podman",
        [
          ...this.#baseArguments(),
          `--mount=type=bind,src=${this.#configuration.databaseDirectory},dst=/database,ro=true,relabel=private`,
          "--entrypoint=/usr/bin/sigtool",
          this.#configuration.imageReference,
          "--info",
          `/database/${path.basename(databasePath)}`,
        ],
        options,
      );
    }
    if (args.length === 1 && args[0] === "--version") {
      return this.runner.run(
        "podman",
        [
          ...this.#baseArguments(),
          "--entrypoint=/usr/bin/clamscan",
          this.#configuration.imageReference,
          "--version",
        ],
        options,
      );
    }
    const inputPath = args.at(-1);
    const separatorIndex = args.lastIndexOf("--");
    if (
      inputPath === undefined ||
      !isSafeJobInputPath(inputPath) ||
      separatorIndex !== args.length - 2 ||
      args[0] !== `--database=${this.#configuration.databaseDirectory}` ||
      args[1] !== "--no-summary" ||
      args[2] !== "--stdout" ||
      args[3] !== "--infected"
    ) {
      return Promise.resolve(FAILED_PROCESS);
    }
    return this.runner.run(
      "podman",
      [
        ...this.#baseArguments(),
        `--mount=type=bind,src=${this.#configuration.databaseDirectory},dst=/database,ro=true,relabel=private`,
        `--mount=type=bind,src=${path.dirname(inputPath)},dst=/input,ro=true,relabel=private`,
        "--entrypoint=/usr/bin/clamscan",
        this.#configuration.imageReference,
        "--database=/database",
        "--no-summary",
        "--stdout",
        "--infected",
        "--",
        `/input/${path.basename(inputPath)}`,
      ],
      options,
    );
  }

  #baseArguments(): readonly string[] {
    return [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--user=100:101",
      "--userns=keep-id:uid=100,gid=101",
      "--pids-limit=64",
      `--memory=${CLAMAV_SCANNER_MEMORY_BYTES}`,
      "--cpus=1",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
    ];
  }
}

function isSafeAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    value !== path.parse(value).root &&
    !value.includes(",") &&
    !/[\r\n\0]/.test(value)
  );
}

function isSafeJobInputPath(value: string): boolean {
  return (
    isSafeAbsolutePath(value) &&
    path.dirname(value) !== path.parse(value).root &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(path.basename(value))
  );
}
