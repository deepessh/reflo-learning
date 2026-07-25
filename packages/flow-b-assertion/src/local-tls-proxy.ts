#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";

const certificatePath = required("REFLO_FLOW_B_TLS_CERT_PATH");
const keyPath = required("REFLO_FLOW_B_TLS_KEY_PATH");
const port = integer("REFLO_FLOW_B_TLS_PORT");
const target = safeLoopbackTarget(required("REFLO_FLOW_B_TLS_TARGET"));

const server = createServer(
  {
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
  },
  (incoming, outgoing) => {
    const forwarded = httpRequest(
      new URL(incoming.url ?? "/", target),
      {
        headers: {
          ...incoming.headers,
          host: target.host,
        },
        method: incoming.method,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      outgoing.end("local proxy target unavailable");
    });
    incoming.pipe(forwarded);
  },
);

server.listen(port, "127.0.0.1", () => {
  console.info(`Reflo local TLS proxy listening on 127.0.0.1:${port}`);
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integer(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function safeLoopbackTarget(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("REFLO_FLOW_B_TLS_TARGET is unsafe");
  }
  return url;
}

function shutdown(): void {
  server.close(() => process.exit());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
