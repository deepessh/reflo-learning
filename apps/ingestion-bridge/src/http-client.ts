import { Readable } from "node:stream";

import {
  IngestionError,
  LOCAL_BRIDGE_HTTP,
  LOCAL_BRIDGE_MAX_INPUT_BYTES,
  LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  LOCAL_INGESTION_BRIDGE_VERSION,
  localBridgeLeaseCompletePath,
  localBridgeLeaseInputPath,
  localBridgeLeaseOutputPath,
  parseLocalBridgeCompletion,
  parseLocalBridgeHeartbeat,
  parseLocalBridgeLease,
  parseLocalBridgeOutputMetadata,
  type LocalBridgeCompletion,
  type LocalBridgeHeartbeat,
  type LocalBridgeLease,
  type LocalBridgeOutputMetadata,
} from "@reflo/ingestion";

import type {
  BridgeLeaseInput,
  LocalIngestionBridgeApiPort,
} from "./bridge.js";

const JSON_LIMIT = 16 * 1_024;

export type BridgeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class LocalIngestionBridgeHttpClient implements LocalIngestionBridgeApiPort {
  readonly #origin: URL;

  constructor(
    origin: URL,
    private readonly bearerToken: string,
    private readonly request: BridgeFetch = fetch,
  ) {
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.port === "" ||
      origin.pathname !== "/" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      !/^[A-Za-z0-9._~-]{32,512}$/.test(bearerToken)
    ) {
      unavailable();
    }
    this.#origin = new URL(origin.href);
  }

  async heartbeat(heartbeat: LocalBridgeHeartbeat): Promise<void> {
    parseLocalBridgeHeartbeat(heartbeat);
    const response = await this.#fetch(
      LOCAL_BRIDGE_HTTP.heartbeatPath,
      {
        body: JSON.stringify(heartbeat),
        headers: this.#headers("application/json"),
        method: "POST",
      },
      10_000,
    );
    await expectEmpty(response, 204);
  }

  async lease(
    heartbeat: LocalBridgeHeartbeat,
  ): Promise<BridgeLeaseInput | null> {
    parseLocalBridgeHeartbeat(heartbeat);
    const response = await this.#fetch(
      LOCAL_BRIDGE_HTTP.leasePath,
      { headers: this.#headers(), method: "POST" },
      15_000,
    );
    if (response.status === 204) {
      await expectEmpty(response, 204);
      return null;
    }
    if (response.status !== 200) unavailable();
    const lease = parseLocalBridgeLease(await boundedJson(response));
    const input = await this.#fetch(
      localBridgeLeaseInputPath(lease.leaseId),
      { headers: this.#headers(), method: "GET" },
      5 * 60_000,
    );
    validateInputResponse(input, lease);
    return {
      lease,
      source: responseBytes(input, 5 * 60_000),
    };
  }

  async putOutput(
    lease: LocalBridgeLease,
    metadata: LocalBridgeOutputMetadata,
    output: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    parseLocalBridgeLease(lease);
    const parsed = parseLocalBridgeOutputMetadata(metadata);
    if (parsed.leaseId !== lease.leaseId) unavailable();
    const body = Readable.toWeb(
      Readable.from(output),
    ) as unknown as NonNullable<RequestInit["body"]>;
    const response = await this.#fetch(
      localBridgeLeaseOutputPath(lease.leaseId),
      {
        body,
        headers: {
          ...this.#headers("application/json"),
          "content-length": String(parsed.byteLength),
          [LOCAL_BRIDGE_HTTP.outputSha256Header]: parsed.outputSha256,
        },
        method: "PUT",
        // Node fetch requires this for a streamed request body.
        ...({ duplex: "half" } as unknown as RequestInit),
      },
      30 * 60_000,
    );
    await expectEmpty(response, 204);
  }

  async complete(completion: LocalBridgeCompletion): Promise<void> {
    const parsed = parseLocalBridgeCompletion(completion);
    const response = await this.#fetch(
      localBridgeLeaseCompletePath(parsed.leaseId),
      {
        body: JSON.stringify(parsed),
        headers: this.#headers("application/json"),
        method: "POST",
      },
      10_000,
    );
    await expectEmpty(response, 204);
  }

  #headers(contentType?: string): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.bearerToken}`,
      [LOCAL_BRIDGE_HTTP.contractHeader]: LOCAL_INGESTION_BRIDGE_VERSION,
      ...(contentType === undefined ? {} : { "content-type": contentType }),
    };
  }

  async #fetch(
    route: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      return await this.request(new URL(route, this.#origin), {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      unavailable();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateInputResponse(
  response: Response,
  lease: LocalBridgeLease,
): void {
  const length = readLength(response.headers.get("content-length"));
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/pdf" ||
    response.headers.get(LOCAL_BRIDGE_HTTP.contractHeader) !==
      LOCAL_INGESTION_BRIDGE_VERSION ||
    response.headers.get(LOCAL_BRIDGE_HTTP.inputSha256Header) !==
      lease.inputSha256 ||
    length !== lease.inputBytes ||
    length > LOCAL_BRIDGE_MAX_INPUT_BYTES ||
    response.body === null
  ) {
    void response.body?.cancel();
    unavailable();
  }
}

async function expectEmpty(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    await response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  const length = response.headers.get("content-length");
  if (length !== null && length !== "0") {
    await response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  await response.body?.cancel().catch(() => undefined);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    await response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  const length = response.headers.get("content-length");
  if (length !== null && readLength(length) > JSON_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of responseBytes(response, 10_000)) {
    total += chunk.byteLength;
    if (total > JSON_LIMIT) unavailable();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch {
    unavailable();
  }
}

async function* responseBytes(
  response: Response,
  timeoutMs: number,
): AsyncGenerator<Uint8Array> {
  if (response.body === null) unavailable();
  const reader = response.body.getReader();
  let completed = false;
  let timedOut = false;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    rejectTimeout?.(new Error("bridge response timed out"));
  }, timeoutMs);
  timeout.unref();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeoutFailure]);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } catch {
    unavailable();
  } finally {
    clearTimeout(timeout);
    if (!completed || timedOut) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readLength(value: string | null): number {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) unavailable();
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > LOCAL_BRIDGE_MAX_OUTPUT_BYTES
  ) {
    unavailable();
  }
  return parsed;
}

function unavailable(): never {
  throw new IngestionError("infrastructure_unavailable");
}
