import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

import * as Credentials from "@alicloud/credentials";
import * as FunctionComputeSdk from "@alicloud/fc20230330";
import {
  CreateSessionInput,
  CreateSessionRequest,
  DeleteSessionRequest,
  InvokeFunctionHeaders,
  InvokeFunctionRequest,
} from "@alicloud/fc20230330";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";

import {
  FC_SESSION_MAX_CHUNK_BYTES,
  INGESTION_LIMITS,
  type WorkerExecutionRequest,
} from "../contracts.js";
import { IngestionError } from "../errors.js";
import {
  decodeFunctionSessionFrame,
  encodeFunctionSessionFrame,
  functionSessionChunkCount,
  functionSessionSha256,
  type FunctionSessionHeader,
} from "../function-session-protocol.js";
import type {
  FunctionComputeSessionClientPort,
  IsolatedDocumentWorkerPort,
} from "../ports.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;

export function aliFunctionComputeInternalEndpoint(input: {
  readonly accountId: string;
  readonly region: "ap-southeast-1";
}): string {
  if (!/^[0-9]{6,32}$/.test(input.accountId)) {
    throw unavailable();
  }
  return `${input.accountId}.${input.region}-internal.fc.aliyuncs.com`;
}

export interface FunctionComputeSessionWorkerConfiguration {
  readonly workerArtifactDigest: string;
}

export class FunctionComputeSessionDocumentWorker implements IsolatedDocumentWorkerPort {
  constructor(
    private readonly configuration: FunctionComputeSessionWorkerConfiguration,
    private readonly client: FunctionComputeSessionClientPort,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(configuration.workerArtifactDigest)) {
      throw unavailable();
    }
  }

  async execute(request: WorkerExecutionRequest): Promise<unknown> {
    const input = await readInput(request);
    let sessionId: string | undefined;
    let terminalError: unknown;
    let cleanupFailed = false;
    let document: unknown;
    try {
      sessionId = `r${randomBytes(24).toString("hex")}`;
      const session = await this.client.createSession(sessionId);
      if (
        !SESSION_ID_PATTERN.test(session.sessionId) ||
        session.sessionId !== sessionId
      ) {
        throw unavailable();
      }
      await this.upload(sessionId, request, input);
      const result = await this.parse(sessionId, request);
      const output = await this.download(
        sessionId,
        request,
        result.outputBytes,
        result.outputSha256,
        result.totalChunks,
      );
      try {
        document = JSON.parse(Buffer.from(output).toString("utf8")) as unknown;
      } catch {
        throw new IngestionError("invalid_output");
      }
    } catch (error) {
      terminalError = error;
    } finally {
      if (sessionId !== undefined) {
        try {
          const cleanup = await this.invoke(sessionId, {
            action: "cleanup",
            contractVersion: "serverless-isolated-ingestion-session-v1",
            inputSha256: request.inputSha256,
            operationId: request.operationId,
          });
          cleanupFailed =
            cleanup.header.action !== "ack" ||
            cleanup.header.phase !== "cleanup";
        } catch {
          cleanupFailed = true;
        }
        try {
          await this.client.deleteSession(sessionId);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) {
      throw unavailable("function_session_cleanup_incomplete");
    }
    if (terminalError !== undefined) {
      throw terminalError;
    }
    return document;
  }

  private async upload(
    sessionId: string,
    request: WorkerExecutionRequest,
    input: Uint8Array,
  ): Promise<void> {
    const totalChunks = functionSessionChunkCount(input.byteLength);
    for (let sequence = 0; sequence < totalChunks; sequence++) {
      const start = sequence * FC_SESSION_MAX_CHUNK_BYTES;
      const payload = input.subarray(
        start,
        Math.min(start + FC_SESSION_MAX_CHUNK_BYTES, input.byteLength),
      );
      const header = {
        action: "upload",
        chunkSha256: functionSessionSha256(payload),
        contractVersion: "serverless-isolated-ingestion-session-v1",
        documentKind: request.documentKind,
        inputSha256: request.inputSha256,
        operationId: request.operationId,
        processingLane: request.processingLane,
        sequence,
        totalBytes: input.byteLength,
        totalChunks,
        workerArtifactDigest: this.configuration.workerArtifactDigest,
      } as const;
      let response;
      try {
        response = await this.invoke(sessionId, header, payload);
      } catch (error) {
        if (!isTransportError(error)) {
          throw error;
        }
        const state = await this.inspect(sessionId, request);
        if (
          (state.phase === "uploading" || state.phase === "uploaded") &&
          state.nextUploadSequence === sequence + 1
        ) {
          continue;
        }
        if (
          (state.phase !== "uploading" && state.phase !== "uploaded") ||
          state.nextUploadSequence !== sequence
        ) {
          throw error;
        }
        response = await this.invoke(sessionId, header, payload);
      }
      if (
        response.header.action !== "ack" ||
        response.header.phase !== "upload" ||
        response.header.sequence !== sequence
      ) {
        throw mappedFailure(response.header);
      }
    }
  }

  private async download(
    sessionId: string,
    request: WorkerExecutionRequest,
    outputBytes: number,
    outputSha256: string,
    totalChunks: number,
  ): Promise<Uint8Array> {
    if (
      outputBytes > INGESTION_LIMITS.normalizedOutputBytes ||
      totalChunks !== functionSessionChunkCount(outputBytes)
    ) {
      throw new IngestionError("invalid_output");
    }
    const output = Buffer.allocUnsafe(outputBytes);
    let offset = 0;
    for (let sequence = 0; sequence < totalChunks; sequence++) {
      const header = {
        action: "download",
        contractVersion: "serverless-isolated-ingestion-session-v1",
        inputSha256: request.inputSha256,
        operationId: request.operationId,
        sequence,
      } as const;
      let response;
      try {
        response = await this.invoke(sessionId, header);
      } catch (error) {
        if (!isTransportError(error)) {
          throw error;
        }
        const state = await this.inspect(sessionId, request);
        if (
          state.phase !== "parsed" ||
          (state.nextDownloadSequence !== sequence &&
            state.nextDownloadSequence !== sequence + 1)
        ) {
          throw error;
        }
        response = await this.invoke(sessionId, header);
      }
      if (
        response.header.action !== "chunk" ||
        response.header.sequence !== sequence ||
        response.header.outputBytes !== outputBytes ||
        response.header.outputSha256 !== outputSha256 ||
        response.header.totalChunks !== totalChunks ||
        offset + response.payload.byteLength > output.byteLength
      ) {
        throw mappedFailure(response.header);
      }
      Buffer.from(response.payload).copy(output, offset);
      offset += response.payload.byteLength;
    }
    if (
      offset !== outputBytes ||
      functionSessionSha256(output) !== outputSha256
    ) {
      throw new IngestionError("invalid_output");
    }
    return output;
  }

  private async invoke(
    sessionId: string,
    header: FunctionSessionHeader,
    payload?: Uint8Array,
  ) {
    let bytes: Uint8Array;
    try {
      bytes = await this.client.invoke(
        sessionId,
        encodeFunctionSessionFrame(header, payload),
      );
    } catch {
      throw unavailable("function_session_transport");
    }
    const response = decodeFunctionSessionFrame(bytes);
    if (response.header.action === "failure") {
      throw mappedFailure(response.header);
    }
    return response;
  }

  private async inspect(
    sessionId: string,
    request: WorkerExecutionRequest,
  ): Promise<Extract<FunctionSessionHeader, { readonly action: "state" }>> {
    const response = await this.invoke(sessionId, {
      action: "inspect",
      contractVersion: "serverless-isolated-ingestion-session-v1",
      inputSha256: request.inputSha256,
      operationId: request.operationId,
    });
    if (response.header.action !== "state") {
      throw mappedFailure(response.header);
    }
    return response.header;
  }

  private async parse(
    sessionId: string,
    request: WorkerExecutionRequest,
  ): Promise<Extract<FunctionSessionHeader, { readonly action: "result" }>> {
    const header = {
      action: "parse",
      contractVersion: "serverless-isolated-ingestion-session-v1",
      inputSha256: request.inputSha256,
      operationId: request.operationId,
    } as const;
    try {
      const response = await this.invoke(sessionId, header);
      if (response.header.action !== "result") {
        throw mappedFailure(response.header);
      }
      return response.header;
    } catch (error) {
      if (!isTransportError(error)) {
        throw error;
      }
      const state = await this.inspect(sessionId, request);
      if (state.phase === "parsed") {
        return {
          action: "result",
          contractVersion: "serverless-isolated-ingestion-session-v1",
          outputBytes: state.outputBytes,
          outputSha256: state.outputSha256,
          totalChunks: state.totalChunks,
        };
      }
      if (state.phase !== "uploaded") {
        throw error;
      }
      const response = await this.invoke(sessionId, header);
      if (response.header.action !== "result") {
        throw mappedFailure(response.header);
      }
      return response.header;
    }
  }
}

export interface AliFunctionComputeSessionConfiguration {
  readonly accountId: string;
  readonly affinityHeaderName: string;
  readonly functionName: string;
  readonly qualifier: string;
  readonly region: "ap-southeast-1";
  readonly roleName: string;
  readonly sessionIdleTimeoutSeconds: number;
  readonly sessionTtlSeconds: number;
}

export class AliFunctionComputeSessionClient implements FunctionComputeSessionClientPort {
  readonly #client: InstanceType<typeof FunctionComputeSdk.default.default>;
  readonly #configuration: AliFunctionComputeSessionConfiguration;

  constructor(configuration: AliFunctionComputeSessionConfiguration) {
    validateAliConfiguration(configuration);
    this.#configuration = configuration;
    const provider = Credentials.ECSRAMRoleCredentialsProvider.builder()
      .withRoleName(configuration.roleName)
      .withDisableIMDSv1(true)
      .withConnectTimeout(1_000)
      .withReadTimeout(1_000)
      .build();
    this.#client = new FunctionComputeSdk.default.default(
      new $OpenApiUtil.Config({
        connectTimeout: 5_000,
        credential: new Credentials.default.default(undefined, provider),
        endpoint: aliFunctionComputeInternalEndpoint(configuration),
        protocol: "HTTPS",
        readTimeout: 1_795_000,
        regionId: configuration.region,
      }),
    );
  }

  async createSession(
    requestedSessionId: string,
  ): Promise<{ readonly sessionId: string }> {
    if (!SESSION_ID_PATTERN.test(requestedSessionId)) {
      throw unavailable();
    }
    try {
      const response = await this.#client.createSessionWithOptions(
        this.#configuration.functionName,
        new CreateSessionRequest({
          body: new CreateSessionInput({
            allowInternetAccess: false,
            disableSessionIdReuse: true,
            sessionId: requestedSessionId,
            sessionIdleTimeoutInSeconds:
              this.#configuration.sessionIdleTimeoutSeconds,
            sessionTTLInSeconds: this.#configuration.sessionTtlSeconds,
          }),
          qualifier: this.#configuration.qualifier,
        }),
        {},
        runtimeOptions(),
      );
      const body = response.body;
      if (
        response.statusCode !== 200 ||
        body?.sessionStatus !== "Active" ||
        body.sessionAffinityType !== "HEADER_FIELD" ||
        body.disableSessionIdReuse !== true ||
        body.allowInternetAccess === true ||
        body.functionName !== this.#configuration.functionName ||
        body.qualifier !== this.#configuration.qualifier ||
        body.sessionIdleTimeoutInSeconds !==
          this.#configuration.sessionIdleTimeoutSeconds ||
        body.sessionTTLInSeconds !== this.#configuration.sessionTtlSeconds ||
        body.sessionId === undefined ||
        body.sessionId !== requestedSessionId
      ) {
        throw unavailable();
      }
      return { sessionId: body.sessionId };
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }

  async invoke(sessionId: string, request: Uint8Array): Promise<Uint8Array> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw unavailable();
    }
    try {
      const response = await this.#client.invokeFunctionWithOptions(
        this.#configuration.functionName,
        new InvokeFunctionRequest({
          body: Readable.from([Buffer.from(request)]),
          qualifier: this.#configuration.qualifier,
        }),
        new InvokeFunctionHeaders({
          commonHeaders: {
            [this.#configuration.affinityHeaderName]: sessionId,
            "content-type": "application/octet-stream",
          },
          xFcInvocationType: "Sync",
          xFcLogType: "None",
        }),
        runtimeOptions(),
      );
      if (
        response.statusCode !== 200 ||
        response.body === undefined ||
        response.headers?.["x-fc-function-error"] !== undefined
      ) {
        throw unavailable();
      }
      return readBoundedResponse(response.body);
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw unavailable();
    }
    try {
      const response = await this.#client.deleteSessionWithOptions(
        this.#configuration.functionName,
        sessionId,
        new DeleteSessionRequest({
          qualifier: this.#configuration.qualifier,
        }),
        {},
        runtimeOptions(),
      );
      if (response.statusCode !== 200 && response.statusCode !== 204) {
        throw unavailable();
      }
    } catch (error) {
      throw normalizeTransportError(error);
    }
  }
}

async function readInput(request: WorkerExecutionRequest): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(request.inputPath, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > INGESTION_LIMITS.largeDocument.maxBytes
    ) {
      throw unavailable();
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== stat.size ||
      functionSessionSha256(bytes) !== request.inputSha256
    ) {
      throw new IngestionError("hash_mismatch");
    }
    return bytes;
  } catch (error) {
    if (error instanceof IngestionError) {
      throw error;
    }
    throw unavailable();
  } finally {
    await handle?.close();
  }
}

async function readBoundedResponse(stream: Readable): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const value of stream) {
    const part = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += part.byteLength;
    if (length > FC_SESSION_MAX_CHUNK_BYTES + 16 * 1_024 + 16) {
      stream.destroy();
      throw unavailable();
    }
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

function runtimeOptions(): RuntimeOptions {
  return new RuntimeOptions({
    autoretry: false,
    connectTimeout: 5_000,
    maxAttempts: 1,
    readTimeout: 1_795_000,
  });
}

function mappedFailure(header: FunctionSessionHeader): IngestionError {
  return header.action === "failure"
    ? new IngestionError(header.code)
    : new IngestionError("infrastructure_unavailable");
}

function normalizeTransportError(error: unknown): IngestionError {
  return error instanceof IngestionError ? error : unavailable();
}

function isTransportError(error: unknown): error is IngestionError {
  return (
    error instanceof IngestionError &&
    error.code === "infrastructure_unavailable" &&
    error.sanitizedDetail === "function_session_transport"
  );
}

function validateAliConfiguration(
  value: AliFunctionComputeSessionConfiguration,
): void {
  if (
    !/^[0-9]{6,32}$/.test(value.accountId) ||
    !/^[A-Za-z][A-Za-z0-9_-]{4,39}$/.test(value.affinityHeaderName) ||
    value.affinityHeaderName.toLowerCase().startsWith("x-fc-") ||
    !/^[a-z][a-z0-9-]{2,63}$/.test(value.functionName) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.qualifier) ||
    value.region !== "ap-southeast-1" ||
    !/^[A-Za-z0-9@._-]{1,64}$/.test(value.roleName) ||
    !Number.isSafeInteger(value.sessionIdleTimeoutSeconds) ||
    value.sessionIdleTimeoutSeconds < 60 ||
    value.sessionIdleTimeoutSeconds > 1_800 ||
    !Number.isSafeInteger(value.sessionTtlSeconds) ||
    value.sessionTtlSeconds < value.sessionIdleTimeoutSeconds ||
    value.sessionTtlSeconds > 3_600
  ) {
    throw unavailable();
  }
}

function unavailable(detail?: string): IngestionError {
  return new IngestionError("infrastructure_unavailable", detail);
}
