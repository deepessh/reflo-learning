import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CdpResponse {
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: Record<string, unknown>;
}

interface CdpEvaluationResult {
  readonly exceptionDetails?: {
    readonly exception?: {
      readonly description?: string;
    };
    readonly text?: string;
  };
  readonly result?: {
    readonly description?: string;
    readonly value?: unknown;
  };
}

export class ChromeCdpSession {
  readonly #child: ChildProcess;
  readonly #diagnostics: string[] = [];
  readonly #pending = new Map<
    number,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (value: Record<string, unknown>) => void;
    }
  >();
  readonly #profileDirectory: string;
  readonly #socket: WebSocket;
  #closed = false;
  #nextId = 1;

  private constructor(
    child: ChildProcess,
    profileDirectory: string,
    socket: WebSocket,
  ) {
    this.#child = child;
    this.#profileDirectory = profileDirectory;
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.#onMessage(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("Chrome DevTools connection closed"));
    });
    socket.addEventListener("error", () => {
      this.#rejectPending(new Error("Chrome DevTools connection failed"));
    });
  }

  static async launch(
    executable: string,
    timeoutMs: number,
    options: { readonly ignoreCertificateErrors?: boolean } = {},
  ): Promise<ChromeCdpSession> {
    const profileDirectory = await mkdtemp(
      path.join(os.tmpdir(), "reflo-flow-b-chrome-"),
    );
    const child = spawn(
      executable,
      [
        "--headless=new",
        ...(options.ignoreCertificateErrors === true
          ? ["--ignore-certificate-errors"]
          : []),
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-features=Translate,OptimizationHints",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--no-first-run",
        "--remote-allow-origins=*",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDirectory}`,
        "about:blank",
      ],
      {
        stdio: "ignore",
      },
    );
    try {
      const endpoint = await devToolsEndpoint(
        profileDirectory,
        child,
        timeoutMs,
      );
      const socket = await openSocket(endpoint, timeoutMs);
      return new ChromeCdpSession(child, profileDirectory, socket);
    } catch (error) {
      child.kill("SIGTERM");
      await rm(profileDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  async enable(): Promise<void> {
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Network.enable"),
    ]);
  }

  async addScriptOnNewDocument(source: string): Promise<void> {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async navigate(url: URL): Promise<void> {
    await this.send("Page.navigate", { url: url.toString() });
  }

  async evaluate<Value>(expression: string): Promise<Value> {
    const response = (await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: true,
    })) as CdpEvaluationResult;
    if (response.exceptionDetails !== undefined) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          response.result?.description ??
          "browser evaluation failed",
      );
    }
    return response.result?.value as Value;
  }

  diagnostics(): readonly string[] {
    return [...this.#diagnostics];
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.send("Browser.close").catch(() => undefined);
    await waitForExit(this.#child, 2_000);
    if (this.#child.exitCode === null) {
      this.#child.kill("SIGTERM");
      await waitForExit(this.#child, 2_000);
    }
    await rm(this.#profileDirectory, { force: true, recursive: true });
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> {
    if (this.#closed && method !== "Browser.close") {
      return Promise.reject(new Error("Chrome DevTools session is closed"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.#pending.delete(id);
        reject(new Error("Chrome DevTools command could not be sent"));
      }
    });
  }

  #onMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) {
      this.#captureDiagnostic(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new Error(
          `Chrome DevTools command failed (${message.error.code}): ${message.error.message}`,
        ),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #captureDiagnostic(message: CdpResponse): void {
    if (
      message.method !== "Runtime.exceptionThrown" &&
      message.method !== "Log.entryAdded"
    ) {
      return;
    }
    const params = asRecord(message.params);
    const exceptionDetails = asRecord(params.exceptionDetails);
    const exception = asRecord(exceptionDetails.exception);
    const entry = asRecord(params.entry);
    const value =
      safeDiagnostic(exception.description) ??
      safeDiagnostic(exceptionDetails.text) ??
      safeDiagnostic(entry.text);
    if (value !== undefined) {
      this.#diagnostics.push(value);
      if (this.#diagnostics.length > 10) {
        this.#diagnostics.shift();
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

async function devToolsEndpoint(
  profileDirectory: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  const activePortPath = path.join(profileDirectory, "DevToolsActivePort");
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error("Chrome exited before DevTools became ready");
    }
    const active = await readFile(activePortPath, "utf8").catch(() => null);
    if (active !== null) {
      const [port, browserPath] = active.trim().split("\n");
      if (
        port !== undefined &&
        /^\d+$/.test(port) &&
        browserPath?.startsWith("/devtools/browser/")
      ) {
        const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then(
          (response) => response.json(),
        )) as readonly {
          readonly type?: string;
          readonly webSocketDebuggerUrl?: string;
        }[];
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page?.webSocketDebuggerUrl !== undefined) {
          return page.webSocketDebuggerUrl;
        }
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    }
    await delay(50);
  }
  throw new Error("Chrome DevTools startup timed out");
}

function openSocket(endpoint: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome DevTools WebSocket timed out"));
    }, timeoutMs);
    timer.unref();
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools WebSocket failed"));
      },
      { once: true },
    );
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.slice(0, 1_000);
}
