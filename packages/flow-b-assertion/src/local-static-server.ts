#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve(required("REFLO_FLOW_B_STATIC_ROOT"));
const port = readPort(required("REFLO_FLOW_B_STATIC_PORT"));

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const decoded = decodeURIComponent(url.pathname);
    const relative =
      decoded === "/"
        ? "index.html"
        : decoded.endsWith("/")
          ? `${decoded.slice(1)}index.html`
          : decoded.slice(1);
    const initial = safePath(relative);
    let selected = initial;
    if (!(await regular(selected))) {
      const html = `${initial}.html`;
      selected =
        path.extname(initial) === "" && (await regular(html))
          ? html
          : path.join(root, "404.html");
    }
    const body = await readFile(selected);
    response.writeHead(selected.endsWith("404.html") ? 404 : 200, {
      "cache-control": "no-store",
      "content-type": contentType(selected),
    });
    response.end(body);
  } catch {
    response.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("invalid local static request");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.info(`Reflo local static server listening on 127.0.0.1:${port}`);
});

function safePath(relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("static path escaped its root");
  }
  return candidate;
}

async function regular(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((value) => value.isFile())
    .catch(() => false);
}

function contentType(filename: string): string {
  switch (path.extname(filename)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPort(value: string): number {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 65_535) {
    throw new Error("REFLO_FLOW_B_STATIC_PORT is invalid");
  }
  return selected;
}

function shutdown(): void {
  server.close(() => process.exit());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
