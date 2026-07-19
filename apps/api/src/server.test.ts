import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "./server";

const servers: ReturnType<typeof createApiServer>[] = [];

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

describe("API health endpoint", () => {
  it("returns the shared health contract", async () => {
    const server = createApiServer({
      deployment: "dev",
      host: "127.0.0.1",
      port: 0,
      service: "api",
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to expose a TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: 1,
      environment: "dev",
      service: "api",
      status: "ok",
    });
  });
});
