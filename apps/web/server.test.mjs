import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebServer, resolveAsset } from "./server.mjs";

const servers = [];
const roots = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("static web container server", () => {
  it("serves exported routes, health, and a bounded not-found response", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "demo"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "home");
    await writeFile(path.join(root, "demo/review.html"), "review");
    await writeFile(path.join(root, "404.html"), "missing");
    const server = createWebServer(root);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected web server to bind TCP");
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const route = await fetch(`${origin}/demo/review?delivery=synthetic`);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe("review");

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      contractVersion: 1,
      service: "web",
      status: "ok",
    });

    const missing = await fetch(`${origin}/outside`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("missing");
  });

  it("does not resolve traversal outside the exported root", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "index.html"), "home");

    await expect(resolveAsset(root, "/%2e%2e/secret")).resolves.toBeNull();
    await expect(resolveAsset(root, "/%00")).resolves.toBeNull();
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reflo-web-"));
  roots.push(root);
  return root;
}
