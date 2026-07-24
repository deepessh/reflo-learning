import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

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

    const csrfResponse = await fetch(`${baseUrl}/v1/csrf-token`, {
      headers: { cookie, origin: "https://app.reflo.example" },
    });
    expect(csrfResponse.status).toBe(200);
    expect(await csrfResponse.json()).toEqual({
      csrfToken: setCookies[1]!.split("=", 2)[1]!.split(";", 1)[0],
    });
    expect(
      (
        await fetch(`${baseUrl}/v1/csrf-token`, {
          headers: { cookie, origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("serves an owner-authorized readiness-safe course progress projection", async () => {
    const fixture = createAccountFixture();
    const courseId = "50000000-0000-4000-8000-000000000042";
    fixture.repository.progress.set(courseId, {
      chapters: [
        {
          chapterId: "40000000-0000-4000-8000-000000000042",
          concepts: [
            {
              assessmentStatus: "assessed",
              conceptId: "30000000-0000-4000-8000-000000000042",
              confidence: "0.42857",
              evidenceCount: 3,
              generationVersion: "curriculum-v1",
              lastReviewedAt: new Date("2026-07-24T12:00:00.000Z"),
              mappingStatus: "unmapped",
              mastery: "0.28571",
              name: "Virtual networks",
              order: 0,
              review: {
                fsrsDueAt: new Date("2026-07-25T12:00:00.000Z"),
                nextDeliveryAt: new Date("2026-07-25T16:00:00.000Z"),
                state: "scheduled",
              },
            },
          ],
          order: 1,
          title: "Networking",
        },
      ],
      courseId,
      generatedAt: new Date("2026-07-24T12:01:00.000Z"),
      mastery: {
        assessedConceptCount: 1,
        kind: "course_mastery_estimate",
        label: "Course Mastery Estimate",
        totalConceptCount: 1,
        value: "0.28571",
      },
      readiness: {
        blueprintVersion: null,
        invalidatedConceptCount: 0,
        mappedConceptCount: 0,
        reasons: [
          "blueprint_missing",
          "evidence_minimum_not_met",
          "calibration_unavailable",
        ],
        score: null,
        status: "unavailable",
        targetBlueprintId: null,
        unmappedConceptCount: 1,
      },
      recentSessionDeltas: [],
      title: "Cloud Architecture Foundations",
    });
    const { baseUrl } = await startAccountServer(fixture.service);
    const cookie = await login(baseUrl, fixture.email);

    const response = await fetch(`${baseUrl}/v1/courses/${courseId}/progress`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      progress: {
        courseId,
        mastery: {
          assessedConceptCount: 1,
          kind: "course_mastery_estimate",
          value: "0.28571",
        },
        readiness: {
          mappedConceptCount: 0,
          score: null,
          status: "unavailable",
          unmappedConceptCount: 1,
        },
      },
    });
    expect(
      (
        await fetch(
          `${baseUrl}/v1/courses/50000000-0000-4000-8000-000000000043/progress`,
          { headers: { cookie: cookie.header } },
        )
      ).status,
    ).toBe(404);
  });

  it("serves authenticated demo delivery paths and ignores email replies", async () => {
    const fixture = createAccountFixture();
    const deliveryItemId = "40000000-0000-4000-8000-000000000043";
    const delivery = {
      dispatch: vi.fn().mockResolvedValue({
        delivery: {
          deliveryId: "30000000-0000-4000-8000-000000000043",
          expiresAt: "2026-07-25T12:00:00.000Z",
          items: [],
          provider: "email",
          providerMessageId: "message-43",
          status: "submitted",
        },
        status: "created",
      }),
      handleTelegramWebhook: vi.fn().mockResolvedValue([]),
      previewEmail: vi.fn().mockResolvedValue({
        deliveryId: "30000000-0000-4000-8000-000000000043",
        demoOnly: true,
        expiresAt: "2026-07-25T12:00:00.000Z",
        questions: [],
      }),
      submitEmail: vi.fn().mockResolvedValue([
        {
          attemptId: "70000000-0000-4000-8000-000000000043",
          correct: true,
          status: "created",
          streak: { current: 2, longest: 4 },
        },
      ]),
    };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      delivery,
    );
    const cookie = await login(baseUrl, fixture.email);

    const dispatch = await fetch(`${baseUrl}/v1/demo/deliveries/dispatch`, {
      body: JSON.stringify({
        idempotencyKey: "api/demo-delivery/v1/43",
        provider: "email",
      }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(dispatch.status).toBe(200);
    expect(delivery.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          ownerScopeId: expect.any(String),
        }),
        provider: "email",
      }),
    );

    const preview = await fetch(
      `${baseUrl}/v1/demo/email-quiz?token=signed-token`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(preview.status).toBe(200);
    expect((await preview.json()).quiz.demoOnly).toBe(true);

    const submission = await fetch(`${baseUrl}/v1/demo/email-quiz/submit`, {
      body: JSON.stringify({
        answers: [{ answer: "B", deliveryItemId }],
        token: "signed-token",
      }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(submission.status).toBe(200);
    expect(delivery.submitEmail).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      "signed-token",
      [{ answer: "B", deliveryItemId }],
      expect.stringMatching(/Z$/),
    );

    const telegram = await fetch(`${baseUrl}/v1/webhooks/telegram`, {
      body: "{}",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      method: "POST",
    });
    expect(telegram.status).toBe(200);
    expect(delivery.handleTelegramWebhook).toHaveBeenCalledWith(
      "{}",
      "telegram-secret",
    );

    const reply = await fetch(`${baseUrl}/v1/webhooks/email`, {
      body: "free-form reply that must never be parsed",
      method: "POST",
    });
    expect(reply.status).toBe(204);
    expect(delivery.submitEmail).toHaveBeenCalledTimes(1);
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

  it("serves authenticated, CSRF-protected online Tutor Agent actions", async () => {
    const fixture = createAccountFixture();
    const tutorAgent = {
      ask: vi.fn().mockResolvedValue({
        citations: [
          {
            sectionPath: ["Networking", "VPC"],
            sourceSpanId: "90000000-0000-4000-8000-000000000001",
          },
        ],
        content: "A VPC is an isolated network.",
        kind: "answer",
      }),
      nextAction: vi.fn().mockResolvedValue({
        conceptId: "40000000-0000-4000-8000-000000000001",
        kind: "advance",
      }),
    };
    const { baseUrl } = await startAccountServer(fixture.service, tutorAgent);
    const cookie = await login(baseUrl, fixture.email);
    const sessionId = "70000000-0000-4000-8000-000000000001";

    const nextResponse = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/next`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );
    expect(nextResponse.status).toBe(200);
    expect(await nextResponse.json()).toEqual({
      action: {
        conceptId: "40000000-0000-4000-8000-000000000001",
        kind: "advance",
      },
    });
    expect(tutorAgent.nextAction).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          ownerScopeId: expect.any(String),
        }),
        sessionId,
      }),
    );

    const askResponse = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/ask`,
      {
        body: JSON.stringify({
          courseId: "50000000-0000-4000-8000-000000000001",
          idempotencyKey: "api/tutor-question/v1/one",
          question: "What is a VPC?",
          sourceDocumentId: "80000000-0000-4000-8000-000000000001",
        }),
        headers: {
          "content-type": "application/json",
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );
    expect(askResponse.status).toBe(200);
    expect(await askResponse.json()).toMatchObject({
      answer: {
        citations: [
          {
            sectionPath: ["Networking", "VPC"],
            sourceSpanId: "90000000-0000-4000-8000-000000000001",
          },
        ],
        kind: "answer",
      },
    });
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

async function startAccountServer(
  service: AccountService,
  tutorAgent?: Parameters<typeof createApiServer>[1]["tutorAgent"],
  delivery?: Parameters<typeof createApiServer>[1]["delivery"],
) {
  const server = createApiServer(
    {
      deployment: "dev",
      host: "127.0.0.1",
      port: 0,
      service: "api",
    },
    {
      accounts: service,
      ...(delivery === undefined ? {} : { delivery }),
      ...(tutorAgent === undefined ? {} : { tutorAgent }),
    },
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
