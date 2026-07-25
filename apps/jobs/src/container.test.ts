import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsReadinessServer } from "./container";

const servers: ReturnType<typeof createJobsReadinessServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("jobs container readiness server", () => {
  it("serves the shared health contract and rejects other paths", async () => {
    const server = createJobsReadinessServer({
      deployment: "dev",
      host: "127.0.0.1",
      port: 0,
      service: "jobs",
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected jobs readiness server to bind TCP");
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({
      contractVersion: 1,
      environment: "dev",
      service: "jobs",
      status: "ok",
    });

    const missing = await fetch(`${origin}/ready`);
    expect(missing.status).toBe(404);
  });
});
