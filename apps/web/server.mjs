import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function createWebServer(publicRoot) {
  const root = path.resolve(publicRoot);
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          contractVersion: 1,
          service: "web",
          status: "ok",
        }),
      );
      return;
    }

    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      request.url === undefined
    ) {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    const candidate = await resolveAsset(root, request.url);
    if (candidate === null) {
      await sendFile(
        response,
        path.join(root, "404.html"),
        request.method,
        404,
      );
      return;
    }
    await sendFile(response, candidate, request.method, 200);
  });
}

export async function resolveAsset(publicRoot, requestTarget) {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(requestTarget, "http://web.invalid").pathname,
    );
  } catch {
    return null;
  }
  if (pathname.includes("\0")) {
    return null;
  }

  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidates = path.extname(relative)
    ? [relative]
    : [`${relative}.html`, path.join(relative, "index.html")];

  for (const item of candidates) {
    const absolute = path.resolve(publicRoot, item);
    const fromRoot = path.relative(publicRoot, absolute);
    if (
      fromRoot === "" ||
      fromRoot.startsWith("..") ||
      path.isAbsolute(fromRoot)
    ) {
      continue;
    }
    try {
      const metadata = await stat(absolute);
      await access(absolute);
      if (metadata.isFile()) {
        return absolute;
      }
    } catch {
      // Try the next static-export path shape.
    }
  }
  return null;
}

async function sendFile(response, file, method, status) {
  try {
    const metadata = await stat(file);
    response.writeHead(status, {
      "cache-control": cacheControl(file),
      "content-length": metadata.size,
      "content-type":
        MIME_TYPES.get(path.extname(file)) ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
  }
}

function cacheControl(file) {
  if (path.extname(file) === ".html") {
    return "no-store";
  }
  if (file.includes(`${path.sep}_next${path.sep}static${path.sep}`)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function start() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "out",
  );
  const host = process.env.REFLO_WEB_HOST ?? "127.0.0.1";
  const port = portValue(process.env.REFLO_WEB_PORT ?? "3000");
  const server = createWebServer(root);
  let stopping = false;

  server.listen(port, host, () => {
    console.info(`Reflo web listening on http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`Reflo web received ${signal}; shutting down`);
    server.close((error) => {
      if (error) {
        console.error("Reflo web shutdown failed");
        process.exitCode = 1;
      }
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function portValue(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("REFLO_WEB_PORT must be an integer between 1 and 65535");
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start();
}
