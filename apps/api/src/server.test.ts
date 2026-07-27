import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountService, FixedWindowAuthAbuseLimiter } from "@reflo/accounts";
import {
  FixedAccountClock,
  InMemoryAccountRepository,
  RecordingEmailPort,
  SequentialAccountIdGenerator,
} from "@reflo/accounts/testing";

import { DemoUploadAccessError } from "./demo-upload";
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
        calibration: {
          meanAbsoluteError: null,
          sampleSize: null,
          status: "unavailable",
          version: null,
        },
        evidenceCoverage: "0.00000",
        evidenceEligibleConceptCount: 0,
        invalidatedConceptCount: 0,
        mappedConceptCount: 0,
        mappingSetVersion: null,
        objectiveCount: 0,
        objectiveEvidenceCount: 0,
        objectiveMappedCount: 0,
        profileVersion: "exam-readiness-profile-v1",
        reasons: ["blueprint_missing"],
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

  it("admits only authenticated CSRF-protected operator uploads through the injected owner-scoped service", async () => {
    const fixture = createAccountFixture();
    const uploadId = "55000000-0000-4000-8000-000000000001";
    const courseId = "55000000-0000-4000-8000-000000000002";
    const approval = {
      approvalId: "hf-agents-course-core-v1",
      attribution: "Hugging Face Agents Course contributors",
      contractVersion: "demo-upload-v1" as const,
      extension: "pdf" as const,
      licenseLabel: "Apache-2.0",
      mediaType: "application/pdf" as const,
      sourceRevision: "8c0832eae634ebb34541c65265caa6da4c5d2c57",
      title: "Agents Course core Units 1–4",
    };
    const upload = {
      approvalId: approval.approvalId,
      contractVersion: "demo-upload-v1" as const,
      courseId,
      failure: null,
      processingLane: "standard" as const,
      state: "queued" as const,
      statusUpdatedAt: "2026-07-25T20:00:00.000Z",
      uploadId,
    };
    const outline = {
      chapters: [
        {
          chapterId: "55000000-0000-4000-8000-000000000003",
          concepts: [
            {
              conceptId: "55000000-0000-4000-8000-000000000004",
              name: "Agent planning",
              sourceSpanCount: 2,
            },
          ],
          order: 1,
          title: "Agent foundations",
        },
      ],
      contractVersion: "demo-upload-v1" as const,
      courseId,
      generatedAt: "2026-07-25T20:01:00.000Z",
      title: approval.title,
      uploadId,
    };
    const demoUploads = {
      create: vi.fn().mockResolvedValue(upload),
      get: vi.fn().mockResolvedValue(upload),
      listApprovals: vi.fn().mockResolvedValue([approval]),
      loadOutline: vi.fn().mockResolvedValue(outline),
    };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      { demoUploads },
    );
    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    expect(
      (
        await fetch(`${baseUrl}/v1/demo/uploads`, {
          body: payload,
          headers: {
            "content-type": "application/pdf",
            "x-reflo-demo-source-approval": approval.approvalId,
          },
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(demoUploads.create).not.toHaveBeenCalled();

    const cookie = await login(baseUrl, fixture.email);
    const approvalsResponse = await fetch(
      `${baseUrl}/v1/demo/uploads/approvals`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(approvalsResponse.status).toBe(200);
    expect(await approvalsResponse.json()).toEqual({
      approvals: [approval],
    });

    expect(
      (
        await fetch(`${baseUrl}/v1/demo/uploads`, {
          body: payload,
          headers: {
            "content-type": "application/pdf",
            cookie: cookie.header,
            origin: "https://app.reflo.example",
            "x-reflo-demo-source-approval": approval.approvalId,
          },
          method: "POST",
        })
      ).status,
    ).toBe(403);

    const createResponse = await fetch(`${baseUrl}/v1/demo/uploads`, {
      body: payload,
      headers: {
        "content-type": "application/pdf",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
        "x-reflo-demo-source-approval": approval.approvalId,
      },
      method: "POST",
    });
    expect(createResponse.status).toBe(202);
    expect(await createResponse.json()).toEqual({ upload });
    expect(demoUploads.create).toHaveBeenCalledOnce();
    const [authorization, createInput] = demoUploads.create.mock.calls[0]!;
    expect(authorization).toEqual(
      expect.objectContaining({
        actorId: expect.any(String),
        ownerScopeId: expect.any(String),
      }),
    );
    expect(createInput).toMatchObject({
      approvalId: approval.approvalId,
      mediaType: "application/pdf",
    });
    expect([...createInput.bytes]).toEqual([...payload]);

    const statusResponse = await fetch(
      `${baseUrl}/v1/demo/uploads/${uploadId}`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({ upload });

    const outlineResponse = await fetch(
      `${baseUrl}/v1/demo/uploads/${uploadId}/outline`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(outlineResponse.status).toBe(200);
    expect(await outlineResponse.json()).toEqual({ outline });
  });

  it("fails closed for unapproved upload media and hidden operator authorization", async () => {
    const fixture = createAccountFixture();
    const demoUploads = {
      create: vi.fn(),
      get: vi.fn(),
      listApprovals: vi
        .fn()
        .mockRejectedValue(new DemoUploadAccessError("authorization_denied")),
      loadOutline: vi.fn(),
    };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      { demoUploads },
    );
    const cookie = await login(baseUrl, fixture.email);

    const denied = await fetch(`${baseUrl}/v1/demo/uploads/approvals`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
      },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "demo_upload_not_found" });

    const invalidMedia = await fetch(`${baseUrl}/v1/demo/uploads`, {
      body: new Uint8Array([1]),
      headers: {
        "content-type": "text/plain",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
        "x-reflo-demo-source-approval": "approved-source-v1",
      },
      method: "POST",
    });
    expect(invalidMedia.status).toBe(400);
    expect(demoUploads.create).not.toHaveBeenCalled();
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
      { now: () => new Date("2030-07-25T09:00:00.000Z") },
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
        now: "2030-07-25T09:00:00.000Z",
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
      "2030-07-25T09:00:00.000Z",
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

    const unauthenticated = await fetch(`${baseUrl}/v1/library`, {
      headers: { origin: "https://app.reflo.example" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(
      "https://app.reflo.example",
    );
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

  it("serves bounded preflight, assessment replay, and persisted summaries", async () => {
    const fixture = createAccountFixture();
    const sessionId = "70000000-0000-4000-8000-000000000002";
    const assessmentResult = {
      attemptId: "80000000-0000-4000-8000-000000000002",
      evidence: [],
      fallback: null,
      learnerMessage: "Your response was graded.",
      outcome: "graded" as const,
      replacementForAttemptId: null,
      requestDigest: "a".repeat(64),
      status: "replayed" as const,
    };
    const assessment = {
      gradeReplacement: vi.fn().mockResolvedValue(assessmentResult),
      gradeShortAnswer: vi.fn().mockResolvedValue(assessmentResult),
    };
    const preflight = {
      check: vi.fn().mockResolvedValue({
        boundary: {
          contractVersion: "connected-demo-boundary-v1" as const,
          destinationClass: "staff-controlled-test" as const,
          learnerClass: "staff-controlled" as const,
          sourceClass: "human-approved-rights-cleared" as const,
        },
        checkedAt: "2026-07-24T12:00:00.000Z",
        contractVersion: "connected-demo-preflight-v1",
        dependencies: [
          {
            code: "unavailable",
            contractVersion: "demo-delivery-v1",
            name: "delivery",
          },
          {
            code: "available",
            contractVersion: "route-policy-v6/test-adapter-v1",
            name: "model",
          },
          {
            code: "available",
            contractVersion: "reflo-schema-test-v1",
            name: "postgres",
          },
          {
            code: "available",
            contractVersion: "test-storage-v1",
            name: "storage",
          },
          {
            code: "available",
            contractVersion: "test-vector-v1",
            name: "vector",
          },
        ],
        status: "unavailable",
      }),
    };
    const sessions = {
      loadSummary: vi.fn().mockResolvedValue({
        courseId: "50000000-0000-4000-8000-000000000002",
        sessionId,
        status: "active",
        summary: { flowB: {} },
      }),
    };
    const study = {
      load: vi.fn().mockResolvedValue({
        concept: {
          conceptId: "40000000-0000-4000-8000-000000000162",
          conceptName: "Virtual Private Cloud",
          eligibleAttemptCount: 2,
          latestEligibleAttempt: {
            attemptId: "80000000-0000-4000-8000-000000000001",
            createdAt: "2026-07-24T12:02:00.000Z",
            rubricBand: "incorrect",
          },
          mastery: "0.16667",
        },
        contractVersion: "connected-study-view-v1",
        courseId: "50000000-0000-4000-8000-000000000002",
        demoOnly: true as const,
        lesson: null,
        loopResult: null,
        plan: {
          steps: ["answer", "different_lesson", "retest", "refresh_map"],
          target: "close_evidence_gap",
        },
        question: {
          conceptId: "40000000-0000-4000-8000-000000000162",
          difficulty: 2,
          itemId: "60000000-0000-4000-8000-000000000002",
          itemType: "short_answer",
          prompt: "What makes a VPC isolated?",
        },
        sessionId,
        sourceDocumentId: "90000000-0000-4000-8000-000000000002",
        state: "question",
      }),
    };
    const seed = {
      reset: vi.fn().mockResolvedValue({
        conceptId: "40000000-0000-4000-8000-000000000162",
        courseId: "50000000-0000-4000-8000-000000000162",
        demoOnly: true as const,
        sessionId: "70000000-0000-4000-8000-000000000162",
      }),
    };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      { assessment, preflight, seed, sessions, study },
    );

    const preflightResponse = await fetch(`${baseUrl}/v1/demo/preflight`);
    expect(preflightResponse.status).toBe(503);
    expect(await preflightResponse.json()).toMatchObject({
      contractVersion: "connected-demo-preflight-v1",
      dependencies: [
        { name: "delivery" },
        { name: "model" },
        { name: "postgres" },
        { name: "storage" },
        { name: "vector" },
      ],
      status: "unavailable",
    });

    const cookie = await login(baseUrl, fixture.email);
    const submission = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/answers/short-answer`,
      {
        body: JSON.stringify({
          answer: "A source-grounded answer",
          idempotencyKey: "demo/assessment/v1/retest-2",
          questionId: "60000000-0000-4000-8000-000000000002",
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
    expect(submission.status).toBe(200);
    expect(await submission.json()).toMatchObject({
      result: { status: "replayed" },
    });
    expect(assessment.gradeShortAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          ownerScopeId: expect.any(String),
        }),
        sessionId,
      }),
    );

    const state = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/state`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      view: {
        contractVersion: "connected-study-view-v1",
        question: { itemType: "short_answer" },
        sessionId,
      },
    });
    expect(study.load).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      sessionId,
    );

    const summary = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/summary`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      session: { sessionId, summary: { flowB: {} } },
    });

    const reset = await fetch(`${baseUrl}/v1/demo/seed/reset`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      seed: { demoOnly: true, sessionId: expect.any(String) },
    });
    expect(seed.reset).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
    );
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
  extra: Partial<Parameters<typeof createApiServer>[1]> = {},
) {
  const server = createApiServer(
    {
      deployment: "dev",
      host: "127.0.0.1",
      port: 0,
      service: "api",
    },
    {
      ...extra,
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
