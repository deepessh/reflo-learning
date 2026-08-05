import { createHash } from "node:crypto";

import {
  LOCAL_BRIDGE_HTTP,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  localBridgeLeaseInputPath,
  type LocalBridgeHeartbeat,
  type LocalBridgeLease,
} from "@reflo/ingestion";
import { describe, expect, it } from "vitest";

import { LocalIngestionBridgeHttpClient } from "./http-client.js";

const token = "opaque-local-bridge-token-0000000000000001";
const source = Buffer.from("%PDF-1.7\nfixture\n");
const inputSha256 = createHash("sha256").update(source).digest("hex");
const digest = `sha256:${"a".repeat(64)}`;
const heartbeat: LocalBridgeHeartbeat = {
  checkedAt: "2026-07-31T18:00:00.000Z",
  contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
  podmanClientVersion: "6.0.1",
  podmanServerVersion: "6.0.1",
  profile: LOCAL_INGESTION_BRIDGE_PROFILE,
  rootless: true,
  scannerSnapshotId: `cvd-${"b".repeat(32)}`,
  status: "available",
  workerImageDigest: digest,
};
const lease: LocalBridgeLease = {
  contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
  documentKind: "pdf",
  expiresAt: "2026-07-31T18:02:00.000Z",
  inputBytes: source.byteLength,
  inputSha256,
  leaseId: "c".repeat(48),
  leasedAt: "2026-07-31T18:00:00.000Z",
  operationId: "operation_216_http",
  processingLane: "standard",
  workerImageDigest: digest,
};

describe("local ingestion bridge HTTP client", () => {
  it("rejects a non-loopback authority before making any request", () => {
    expect(
      () =>
        new LocalIngestionBridgeHttpClient(
          new URL("https://example.test"),
          token,
        ),
    ).toThrow();
  });

  it("authenticates every loopback request and validates the separate PDF stream", async () => {
    const requests: Array<{ init: RequestInit; url: URL }> = [];
    const request = async (input: string | URL | Request, init = {}) => {
      const url = new URL(String(input));
      requests.push({ init, url });
      if (url.pathname === LOCAL_BRIDGE_HTTP.heartbeatPath) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === LOCAL_BRIDGE_HTTP.leasePath) {
        return Response.json(lease);
      }
      if (url.pathname === localBridgeLeaseInputPath(lease.leaseId)) {
        return new Response(source, {
          headers: {
            "content-length": String(source.byteLength),
            "content-type": "application/pdf",
            [LOCAL_BRIDGE_HTTP.contractHeader]: LOCAL_INGESTION_BRIDGE_VERSION,
            [LOCAL_BRIDGE_HTTP.inputSha256Header]: inputSha256,
          },
        });
      }
      throw new Error("unexpected request");
    };
    const client = new LocalIngestionBridgeHttpClient(
      new URL("http://127.0.0.1:53001"),
      token,
      request,
    );

    await client.heartbeat(heartbeat);
    const claimed = await client.lease(heartbeat);
    expect(claimed?.lease).toEqual(lease);
    const chunks: Uint8Array[] = [];
    for await (const chunk of claimed!.source) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(source);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      LOCAL_BRIDGE_HTTP.heartbeatPath,
      LOCAL_BRIDGE_HTTP.leasePath,
      localBridgeLeaseInputPath(lease.leaseId),
    ]);
    for (const { init, url } of requests) {
      expect(url.origin).toBe("http://127.0.0.1:53001");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      expect(
        new Headers(init.headers).get(LOCAL_BRIDGE_HTTP.contractHeader),
      ).toBe(LOCAL_INGESTION_BRIDGE_VERSION);
      expect(init.redirect).toBe("error");
    }
  });

  it("rejects a mismatched input contract before yielding bytes", async () => {
    const client = new LocalIngestionBridgeHttpClient(
      new URL("http://127.0.0.1:53001"),
      token,
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === LOCAL_BRIDGE_HTTP.leasePath) return Response.json(lease);
        return new Response(source, {
          headers: {
            "content-length": String(source.byteLength),
            "content-type": "application/pdf",
            [LOCAL_BRIDGE_HTTP.contractHeader]: "wrong-contract",
            [LOCAL_BRIDGE_HTTP.inputSha256Header]: inputSha256,
          },
        });
      },
    );

    await expect(client.lease(heartbeat)).rejects.toMatchObject({
      code: "infrastructure_unavailable",
    });
  });

  it("streams normalized output with exact metadata and sends an allowlisted completion", async () => {
    const output = Buffer.from('{"contractVersion":"normalized-document-v1"}');
    const outputSha256 = createHash("sha256").update(output).digest("hex");
    const requests: RequestInit[] = [];
    const client = new LocalIngestionBridgeHttpClient(
      new URL("http://127.0.0.1:53001"),
      token,
      async (_input, init = {}) => {
        requests.push(init);
        if (init.method === "PUT") {
          const received = Buffer.from(
            await new Response(init.body).arrayBuffer(),
          );
          expect(received).toEqual(output);
        }
        return new Response(null, { status: 204 });
      },
    );

    await client.putOutput(
      lease,
      {
        byteLength: output.byteLength,
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        leaseId: lease.leaseId,
        outputSha256,
      },
      (async function* () {
        yield output.subarray(0, 10);
        yield output.subarray(10);
      })(),
    );
    await client.complete({
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: lease.leaseId,
      outcome: "success",
    });

    const outputHeaders = new Headers(requests[0]!.headers);
    expect(outputHeaders.get("content-length")).toBe(String(output.byteLength));
    expect(outputHeaders.get(LOCAL_BRIDGE_HTTP.outputSha256Header)).toBe(
      outputSha256,
    );
    expect(JSON.parse(String(requests[1]!.body))).toEqual({
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: lease.leaseId,
      outcome: "success",
    });
  });
});
