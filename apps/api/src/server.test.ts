import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { AccountService, FixedWindowAuthAbuseLimiter } from "@reflo/accounts";
import {
  FixedAccountClock,
  InMemoryAccountRepository,
  RecordingEmailPort,
  SequentialAccountIdGenerator,
} from "@reflo/accounts/testing";

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

describe("auth, library, and session-history API", () => {
  it("creates an opaque cookie session and serves the authenticated shells", async () => {
    const fixture = createAccountFixture();
    fixture.repository.library.push({
      chapterCount: 6,
      chaptersReady: 2,
      courseId: "course-a",
      courseStatus: "generating",
      sourceStatus: "parsed",
      title: "Cloud Architecture Foundations",
      updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    fixture.repository.history.push({
      courseId: "course-a",
      courseTitle: "Cloud Architecture Foundations",
      endedAt: new Date("2026-07-20T12:12:00.000Z"),
      sessionId: "session-a",
      startedAt: new Date("2026-07-20T12:00:00.000Z"),
      status: "completed",
      summary: { conceptsReviewed: 3 },
    });
    const { baseUrl } = await startAccountServer(fixture.service);

    const requestResponse = await fetch(`${baseUrl}/v1/auth/magic-link`, {
      body: JSON.stringify({ email: "learner@example.com" }),
      headers: {
        "content-type": "application/json",
        origin: "https://app.reflo.example",
      },
      method: "POST",
    });
    expect(requestResponse.status).toBe(202);
    expect(await requestResponse.json()).toEqual({ accepted: true });

    const token = new URL(fixture.email.messages[0]!.loginUrl).searchParams.get(
      "token",
    );
    const redeemResponse = await fetch(`${baseUrl}/v1/auth/magic-link/redeem`, {
      body: JSON.stringify({ token }),
      headers: {
        "content-type": "application/json",
        origin: "https://app.reflo.example",
      },
      method: "POST",
    });
    expect(redeemResponse.status).toBe(200);
    const setCookies = redeemResponse.headers.getSetCookie();
    expect(setCookies[0]).toContain("__Host-reflo_session=");
    expect(setCookies[0]).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(setCookies[0]).not.toContain("Domain=");
    expect(setCookies[1]).toContain("__Host-reflo_csrf=");
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");

    const libraryResponse = await fetch(`${baseUrl}/v1/library`, {
      headers: { cookie, origin: "https://app.reflo.example" },
    });
    expect(libraryResponse.status).toBe(200);
    expect(await libraryResponse.json()).toMatchObject({
      courses: [
        {
          chaptersReady: 2,
          courseStatus: "generating",
          title: "Cloud Architecture Foundations",
        },
      ],
    });

    const historyResponse = await fetch(`${baseUrl}/v1/session-history`, {
      headers: { cookie, origin: "https://app.reflo.example" },
    });
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toMatchObject({
      sessions: [{ status: "completed", courseId: "course-a" }],
    });
  });

  it("rejects unauthenticated and forged-CSRF access and revokes on logout", async () => {
    const fixture = createAccountFixture();
    const { baseUrl } = await startAccountServer(fixture.service);

    expect((await fetch(`${baseUrl}/v1/library`)).status).toBe(401);
    const cookie = await login(baseUrl, fixture.email);
    expect(
      (
        await fetch(`${baseUrl}/v1/auth/logout`, {
          headers: {
            cookie: cookie.header,
            origin: "https://app.reflo.example",
            "x-reflo-csrf": "forged",
          },
          method: "POST",
        })
      ).status,
    ).toBe(403);

    const logout = await fetch(`${baseUrl}/v1/auth/logout`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect(
      (
        await fetch(`${baseUrl}/v1/library`, {
          headers: { cookie: cookie.header },
        })
      ).status,
    ).toBe(401);
  });

  it("revokes every session before deletion-pending access can continue", async () => {
    const fixture = createAccountFixture();
    const { baseUrl } = await startAccountServer(fixture.service);
    const cookie = await login(baseUrl, fixture.email);

    const deletion = await fetch(`${baseUrl}/v1/account/deletion-start`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(deletion.status).toBe(202);
    expect(
      (
        await fetch(`${baseUrl}/v1/account`, {
          headers: { cookie: cookie.header },
        })
      ).status,
    ).toBe(401);
  });
});

function createAccountFixture() {
  const email = new RecordingEmailPort();
  const repository = new InMemoryAccountRepository();
  const key = (value: number) => new Uint8Array(32).fill(value);
  const service = new AccountService({
    abuseLimiter: new FixedWindowAuthAbuseLimiter(),
    callbackOrigins: ["https://app.reflo.example"],
    clock: new FixedAccountClock(new Date("2026-07-20T12:00:00.000Z")),
    emailEncryptionKey: key(1),
    emailPort: email,
    idGenerator: new SequentialAccountIdGenerator(),
    lookupKey: key(2),
    magicLinkDailyLimit: 200,
    magicLinkTotalLimit: 2_000,
    repository,
    sessionDigestKey: key(3),
    tokenDigestKey: key(4),
  });
  return { email, repository, service };
}

async function startAccountServer(service: AccountService) {
  const server = createApiServer(
    {
      deployment: "dev",
      host: "127.0.0.1",
      port: 0,
      service: "api",
    },
    { accounts: service },
  );
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to expose a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function login(baseUrl: string, email: RecordingEmailPort) {
  await fetch(`${baseUrl}/v1/auth/magic-link`, {
    body: JSON.stringify({ email: "learner@example.com" }),
    headers: {
      "content-type": "application/json",
      origin: "https://app.reflo.example",
    },
    method: "POST",
  });
  const token = new URL(email.messages.at(-1)!.loginUrl).searchParams.get(
    "token",
  );
  const response = await fetch(`${baseUrl}/v1/auth/magic-link/redeem`, {
    body: JSON.stringify({ token }),
    headers: {
      "content-type": "application/json",
      origin: "https://app.reflo.example",
    },
    method: "POST",
  });
  const cookies = response.headers.getSetCookie();
  const csrf = cookies[1]!.split(";", 1)[0]!.split("=", 2)[1]!;
  return {
    csrf,
    header: cookies.map((value) => value.split(";", 1)[0]).join("; "),
  };
}
