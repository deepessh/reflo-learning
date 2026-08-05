import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountService, FixedWindowAuthAbuseLimiter } from "@reflo/accounts";
import { ActivationGenerationError } from "@reflo/activation";
import { AssessmentError } from "@reflo/assessment";
import {
  FixedAccountClock,
  InMemoryAccountRepository,
  RecordingEmailPort,
  SequentialAccountIdGenerator,
} from "@reflo/accounts/testing";
import type { ConnectedActivationProgress } from "@reflo/db";

import { DemoUploadAccessError } from "./demo-upload";
import {
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  LocalIngestionBridgeBroker,
} from "./local-ingestion-bridge";
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

describe("local ingestion bridge internal API", () => {
  it("authenticates before reading bodies and streams one lease through completion", async () => {
    const bearerToken = "server-local-bridge-token-1234567890abcdef";
    const leaseId = "4".repeat(48);
    const broker = new LocalIngestionBridgeBroker({
      bearerToken,
      expectedProfile: LOCAL_INGESTION_BRIDGE_PROFILE,
      expectedScannerSnapshotId: `cvd-${"5".repeat(32)}`,
      expectedWorkerImageDigest: `sha256:${"6".repeat(64)}`,
      heartbeatTtlMs: 10_000,
      leaseDurationMs: 10_000,
      newLeaseId: () => leaseId,
    });
    const server = createApiServer(
      {
        deployment: "dev",
        host: "127.0.0.1",
        port: 0,
        service: "api",
      },
      { localIngestionBridge: broker },
    );
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to expose a TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authorization = { authorization: `Bearer ${bearerToken}` };

    const unauthorized = await fetch(
      `${baseUrl}/internal/v1/local-ingestion/heartbeat`,
      { body: "not-json", method: "POST" },
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();

    const heartbeat = await fetch(
      `${baseUrl}/internal/v1/local-ingestion/heartbeat`,
      {
        body: JSON.stringify({
          checkedAt: "2026-07-31T12:00:00.000Z",
          contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
          podmanClientVersion: "6.0.1",
          podmanServerVersion: "6.0.1",
          profile: LOCAL_INGESTION_BRIDGE_PROFILE,
          rootless: true,
          scannerSnapshotId: `cvd-${"5".repeat(32)}`,
          status: "available",
          workerImageDigest: `sha256:${"6".repeat(64)}`,
        }),
        headers: {
          ...authorization,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(heartbeat.status).toBe(204);

    const root = await mkdtemp(
      path.join(tmpdir(), "reflo-bridge-server-test-"),
    );
    try {
      const input = Buffer.from("%PDF-1.7\nserver-stream-test\n");
      const inputPath = path.join(root, "source");
      const outputDirectory = path.join(root, "output");
      await mkdir(outputDirectory, { mode: 0o700 });
      await writeFile(inputPath, input, { mode: 0o400 });
      const execution = broker.execute({
        documentKind: "pdf",
        inputPath,
        inputSha256: sha256(input),
        operationId: "server-bridge-operation",
        outputDirectory,
        processingLane: "standard",
      });

      const leaseResponse = await fetch(
        `${baseUrl}/internal/v1/local-ingestion/lease`,
        { headers: authorization, method: "POST" },
      );
      expect(leaseResponse.status).toBe(200);
      expect(leaseResponse.headers.get("cache-control")).toBe("no-store");
      expect(await leaseResponse.json()).toMatchObject({ leaseId });

      const inputResponse = await fetch(
        `${baseUrl}/internal/v1/local-ingestion/leases/${leaseId}/input`,
        { headers: authorization },
      );
      expect(inputResponse.status).toBe(200);
      expect(inputResponse.headers.get("content-type")).toBe("application/pdf");
      expect(inputResponse.headers.get("x-reflo-input-sha256")).toBe(
        sha256(input),
      );
      expect(Buffer.from(await inputResponse.arrayBuffer())).toEqual(input);

      const output = Buffer.from(
        JSON.stringify({
          blocks: [],
          contractVersion: "normalized-document-v1",
        }),
      );
      const outputResponse = await fetch(
        `${baseUrl}/internal/v1/local-ingestion/leases/${leaseId}/output`,
        {
          body: output,
          headers: {
            ...authorization,
            "content-type": "application/json",
            "x-reflo-ingestion-contract": LOCAL_INGESTION_BRIDGE_VERSION,
            "x-reflo-output-sha256": sha256(output),
          },
          method: "PUT",
        },
      );
      expect(outputResponse.status).toBe(204);

      const complete = await fetch(
        `${baseUrl}/internal/v1/local-ingestion/leases/${leaseId}/complete`,
        {
          body: JSON.stringify({
            contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
            leaseId,
            outcome: "success",
          }),
          headers: {
            ...authorization,
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      expect(complete.status).toBe(204);
      await expect(execution).resolves.toEqual({
        blocks: [],
        contractVersion: "normalized-document-v1",
      });
    } finally {
      await broker.close();
      await rm(root, { force: true, recursive: true });
    }
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
      contractVersion: "demo-upload-v2" as const,
      extension: "pdf" as const,
      licenseLabel: "Apache-2.0",
      mediaType: "application/pdf" as const,
      sourceRevision: "8c0832eae634ebb34541c65265caa6da4c5d2c57",
      title: "Agents Course core Units 1–4",
    };
    const upload = {
      approvalId: approval.approvalId,
      contractVersion: "demo-upload-v2" as const,
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
      contractVersion: "demo-upload-v2" as const,
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

    for (const mediaType of [
      "application/epub+zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      const invalidMedia = await fetch(`${baseUrl}/v1/demo/uploads`, {
        body: new Uint8Array([1]),
        headers: {
          "content-type": mediaType,
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
          "x-reflo-demo-source-approval": "approved-source-v1",
        },
        method: "POST",
      });
      expect(invalidMedia.status).toBe(415);
      expect(await invalidMedia.json()).toEqual({
        detail: "Uploads accept only an approved digitally generated PDF.",
        error: "unsupported_demo_upload_format",
        supportedMediaType: "application/pdf",
      });
    }
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
      getPreference: vi.fn().mockResolvedValue({
        availableProviders: ["email"],
        chosenLocalTime: "09:00",
        provider: "email",
        timeZone: "UTC",
      }),
      handleTelegramWebhook: vi.fn().mockResolvedValue([]),
      previewEmail: vi.fn().mockResolvedValue({
        deliveryId: "30000000-0000-4000-8000-000000000043",
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
      updatePreference: vi.fn().mockImplementation(async (_auth, value) => ({
        ...value,
        availableProviders: ["email"],
      })),
    };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      delivery,
      { now: () => new Date("2030-07-25T09:00:00.000Z") },
    );
    const cookie = await login(baseUrl, fixture.email);

    const dispatch = await fetch(`${baseUrl}/v1/deliveries/dispatch`, {
      body: JSON.stringify({
        idempotencyKey: "api/demo-delivery/v1/43",
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
      }),
    );

    const preference = await fetch(`${baseUrl}/v1/delivery-preference`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
      },
    });
    expect(preference.status).toBe(200);
    expect(await preference.json()).toEqual({
      preference: {
        availableProviders: ["email"],
        chosenLocalTime: "09:00",
        provider: "email",
        timeZone: "UTC",
      },
    });

    const updatedPreference = await fetch(`${baseUrl}/v1/delivery-preference`, {
      body: JSON.stringify({
        chosenLocalTime: "18:45",
        provider: "email",
        timeZone: "America/Los_Angeles",
      }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(updatedPreference.status).toBe(200);

    const preview = await fetch(`${baseUrl}/v1/email-quiz?token=signed-token`, {
      headers: {
        cookie: cookie.header,
        origin: "https://app.reflo.example",
      },
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).quiz).not.toHaveProperty("demoOnly");

    const submission = await fetch(`${baseUrl}/v1/email-quiz/submit`, {
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
      loadPendingFallback: vi.fn().mockResolvedValue(assessmentResult),
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
      completeLesson: vi.fn().mockResolvedValue(true),
      loadPlacement: vi.fn().mockResolvedValue({
        answered: 3,
        failure: null,
        question: {
          difficulty: 2 as const,
          id: "60000000-0000-4000-8000-000000000003",
          itemType: "multiple_choice" as const,
          position: 4,
          prompt: "Which option is source-grounded?",
          responseOptions: ["First", "Second"],
        },
        status: "question" as const,
        total: 10 as const,
      }),
      loadSummary: vi.fn().mockResolvedValue({
        courseId: "50000000-0000-4000-8000-000000000002",
        sessionId,
        status: "active",
        summary: { flowB: {} },
      }),
      startOrResume: vi.fn().mockResolvedValue({
        courseId: "50000000-0000-4000-8000-000000000002",
        plan: {
          activationStatus: "ready",
          contractVersion: "course-study-plan-v1",
          focusConceptId: "40000000-0000-4000-8000-000000000162",
          nextAction: "review",
          timeBudgetMinutes: 10,
        },
        resumed: false,
        sessionId,
        status: "active" as const,
      }),
      submitPlacementChoice: vi.fn().mockResolvedValue({
        correct: true,
        status: "created" as const,
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
      loadLesson: vi.fn().mockResolvedValue({
        concept: {
          chapterId: "30000000-0000-4000-8000-000000000002",
          conceptId: "40000000-0000-4000-8000-000000000162",
          conceptName: "Virtual Private Cloud",
          mastery: "0.16667",
        },
        content: "A VPC is an isolated network.",
        courseId: "50000000-0000-4000-8000-000000000002",
        kind: "review",
        lesson: {
          assetId: "20000000-0000-4000-8000-000000000002",
          modality: "text",
          servedAt: "2026-07-24T12:00:00.000Z",
          sourceSpanCount: 1,
          strategyTag: "micro-lesson-v1",
        },
        sessionId,
        sourceDocumentId: "90000000-0000-4000-8000-000000000002",
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
    const activation = { schedule: vi.fn() };
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      { activation, assessment, preflight, seed, sessions, study },
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
    preflight.check.mockResolvedValueOnce({
      ...(await preflight.check.mock.results[0]!.value),
      status: "ready",
    });
    const studyPreflight = await fetch(
      `${baseUrl}/v1/preflight?capability=study`,
    );
    expect(studyPreflight.status).toBe(200);
    expect(await studyPreflight.json()).toMatchObject({ status: "ready" });
    expect(preflight.check).toHaveBeenLastCalledWith(false, "study");

    const cookie = await login(baseUrl, fixture.email);
    const started = await fetch(
      `${baseUrl}/v1/courses/50000000-0000-4000-8000-000000000002/study-sessions`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      session: {
        courseId: "50000000-0000-4000-8000-000000000002",
        plan: { nextAction: "review" },
        sessionId,
      },
    });
    expect(activation.schedule).not.toHaveBeenCalled();

    const placement = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/placement`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(placement.status).toBe(200);
    const placementBody = await placement.json();
    expect(placementBody).toEqual({
      placement: {
        answered: 3,
        failure: null,
        question: {
          difficulty: 2,
          id: "60000000-0000-4000-8000-000000000003",
          itemType: "multiple_choice",
          position: 4,
          prompt: "Which option is source-grounded?",
          responseOptions: ["First", "Second"],
        },
        status: "question",
        total: 10,
      },
    });
    expect(JSON.stringify(placementBody)).not.toContain("keyedAnswer");

    const placementSubmission = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/placement/answers`,
      {
        body: JSON.stringify({
          answer: "First",
          idempotencyKey: "placement/test/item-4",
          questionId: "60000000-0000-4000-8000-000000000003",
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
    expect(placementSubmission.status).toBe(200);
    expect(await placementSubmission.json()).toEqual({
      result: { correct: true, status: "created" },
    });
    expect(sessions.submitPlacementChoice).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      sessionId,
      {
        answer: "First",
        idempotencyKey: "placement/test/item-4",
        questionId: "60000000-0000-4000-8000-000000000003",
      },
    );

    sessions.startOrResume.mockResolvedValueOnce({
      courseId: "50000000-0000-4000-8000-000000000002",
      plan: {
        activationStatus: "lesson_pending",
        contractVersion: "course-study-plan-v1",
        focusConceptId: "40000000-0000-4000-8000-000000000162",
        generationRequired: true,
        nextAction: "prepare_activation",
        timeBudgetMinutes: 10,
      },
      resumed: true,
      sessionId,
      status: "active" as const,
    });
    const resumedPending = await fetch(
      `${baseUrl}/v1/courses/50000000-0000-4000-8000-000000000002/study-sessions`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );
    expect(resumedPending.status).toBe(200);
    expect(activation.schedule).toHaveBeenCalledWith({
      authorization: expect.objectContaining({
        actorId: expect.any(String),
        ownerScopeId: expect.any(String),
      }),
      courseId: "50000000-0000-4000-8000-000000000002",
    });

    sessions.startOrResume.mockResolvedValueOnce({
      courseId: "50000000-0000-4000-8000-000000000002",
      plan: {
        activationRequired: false,
        activationStatus: "ready",
        assessmentStatus: "pending",
        contractVersion: "course-study-plan-v1",
        generationRequired: true,
        nextAction: "placement",
      },
      resumed: true,
      sessionId,
      status: "active" as const,
    });
    const partialReady = await fetch(
      `${baseUrl}/v1/courses/50000000-0000-4000-8000-000000000002/study-sessions`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );
    expect(partialReady.status).toBe(200);
    expect(activation.schedule).toHaveBeenCalledTimes(2);

    const lesson = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/lesson`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(lesson.status).toBe(200);
    expect(await lesson.json()).toMatchObject({
      lesson: { content: "A VPC is an isolated network.", kind: "review" },
    });
    const completedLesson = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/lesson/complete`,
      {
        body: JSON.stringify({
          assetId: "20000000-0000-4000-8000-000000000002",
          conceptId: "40000000-0000-4000-8000-000000000162",
          idempotencyKey: "course-study-v1/lesson-completed/test",
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
    expect(completedLesson.status).toBe(200);
    expect(await completedLesson.json()).toEqual({ completed: true });
    expect(sessions.completeLesson).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      sessionId,
      expect.objectContaining({
        assetId: "20000000-0000-4000-8000-000000000002",
        conceptId: "40000000-0000-4000-8000-000000000162",
      }),
    );
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
        deadlineMs: 90_000,
        sessionId,
      }),
    );
    const pendingFallback = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/assessments/pending-fallback`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );
    expect(pendingFallback.status).toBe(200);
    expect(await pendingFallback.json()).toMatchObject({
      result: { attemptId: assessmentResult.attemptId, status: "replayed" },
    });

    assessment.gradeReplacement
      .mockResolvedValueOnce({ ...assessmentResult, status: "created" })
      .mockResolvedValueOnce(assessmentResult);
    const replacementRequest = {
      body: JSON.stringify({
        answer: "Eligible assessment evidence",
        bundleId: "81000000-0000-4000-8000-000000000002",
        idempotencyKey: "web/study/replacement/v1/stable-answer",
        itemId: "82000000-0000-4000-8000-000000000002",
      }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    } as const;
    const replacementCreated = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/answers/replacement`,
      replacementRequest,
    );
    expect(replacementCreated.status).toBe(200);
    expect(await replacementCreated.json()).toMatchObject({
      result: { status: "created" },
    });
    const replacementReplayed = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/answers/replacement`,
      replacementRequest,
    );
    expect(replacementReplayed.status).toBe(200);
    expect(await replacementReplayed.json()).toMatchObject({
      result: { status: "replayed" },
    });
    expect(assessment.gradeReplacement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        answer: "Eligible assessment evidence",
        bundleId: "81000000-0000-4000-8000-000000000002",
        idempotencyKey: "web/study/replacement/v1/stable-answer",
        itemId: "82000000-0000-4000-8000-000000000002",
        sessionId,
      }),
    );
    expect(assessment.gradeReplacement).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "web/study/replacement/v1/stable-answer",
        sessionId,
      }),
    );

    assessment.gradeShortAnswer.mockRejectedValueOnce(
      new AssessmentError("projection_unavailable"),
    );
    const persistedProjectionFailure = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/answers/short-answer`,
      {
        body: JSON.stringify({
          answer: "A source-grounded answer",
          idempotencyKey: "demo/assessment/v1/retest-projection-replay",
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
    expect(persistedProjectionFailure.status).toBe(503);
    expect(await persistedProjectionFailure.json()).toEqual({
      error: "assessment_projection_unavailable",
      persisted: true,
      retryable: true,
    });

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

describe("activation progress event stream", () => {
  const sessionId = "70000000-0000-4000-8000-000000000071";

  it("requires authentication and hides sessions outside the owner scope", async () => {
    const fixture = createAccountFixture();
    const loadActivationProgress = vi.fn().mockResolvedValue(null);
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        sessions: {
          loadActivationProgress,
          loadSummary: vi.fn(),
        },
      },
    );
    const url = `${baseUrl}/v1/study-sessions/${sessionId}/activation/events`;

    expect((await fetch(url)).status).toBe(401);
    expect(loadActivationProgress).not.toHaveBeenCalled();

    const cookie = await login(baseUrl, fixture.email);
    const unavailable = await fetch(url, {
      headers: { cookie: cookie.header },
    });
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toEqual({
      error: "study_session_not_found",
    });
    expect(loadActivationProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: expect.any(String),
        ownerScopeId: expect.any(String),
      }),
      sessionId,
    );
  });

  it("streams processing and retry changes before closing on readiness", async () => {
    const fixture = createAccountFixture();
    const loadActivationProgress = vi
      .fn()
      .mockResolvedValueOnce(
        activationSnapshot({
          activationStatus: "pending",
          attemptCount: 1,
          stage: "generating",
          updatedAt: "2026-08-01T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        activationSnapshot({
          activationStatus: "retrying",
          attemptCount: 1,
          stage: "retry_scheduled",
          updatedAt: "2026-08-01T12:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(
        activationSnapshot({
          activationStatus: "ready",
          attemptCount: 2,
          nextAction: "open_lesson",
          stage: "ready",
          updatedAt: "2026-08-01T12:00:02.000Z",
        }),
      );
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        activationStream: {
          heartbeatIntervalMs: 100,
          maxConnectionMs: 500,
          pollIntervalMs: 5,
          retryAfterMs: 250,
        },
        sessions: {
          loadActivationProgress,
          loadSummary: vi.fn(),
        },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const response = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/activation/events`,
      {
        headers: {
          cookie: cookie.header,
          origin: "https://app.reflo.example",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.reflo.example",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    const body = await response.text();
    expect(body).toContain("retry: 250");
    expect(body.match(/event: activation/g)).toHaveLength(3);
    expect(body).toContain('"stage":"generating"');
    expect(body).toContain('"stage":"retry_scheduled"');
    expect(body).toContain('"nextAction":"open_lesson"');
    expect(loadActivationProgress).toHaveBeenCalledTimes(3);
  });

  it("emits a safe terminal failure and closes immediately", async () => {
    const fixture = createAccountFixture();
    const loadActivationProgress = vi.fn().mockResolvedValue(
      activationSnapshot({
        activationStatus: "failed",
        attemptCount: 5,
        failure: {
          code: "generation_timed_out",
          message: "Lesson preparation took too long to finish.",
        },
        nextAction: "activation_failed",
        stage: "failed",
      }),
    );
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        sessions: {
          loadActivationProgress,
          loadSummary: vi.fn(),
        },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const response = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/activation/events`,
      { headers: { cookie: cookie.header } },
    );
    const body = await response.text();

    expect(body.match(/event: activation/g)).toHaveLength(1);
    expect(body).toContain('"code":"generation_timed_out"');
    expect(body).not.toContain("provider");
    expect(loadActivationProgress).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the browser disconnects", async () => {
    const fixture = createAccountFixture();
    const loadActivationProgress = vi.fn().mockResolvedValue(
      activationSnapshot({
        activationStatus: "pending",
        stage: "generating",
      }),
    );
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        activationStream: {
          heartbeatIntervalMs: 500,
          maxConnectionMs: 1_000,
          pollIntervalMs: 5,
          retryAfterMs: 250,
        },
        sessions: {
          loadActivationProgress,
          loadSummary: vi.fn(),
        },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const response = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/activation/events`,
      { headers: { cookie: cookie.header } },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const callsAfterDisconnect = loadActivationProgress.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadActivationProgress).toHaveBeenCalledTimes(callsAfterDisconnect);
  });

  it("sends heartbeats and a reconnect instruction at the bounded timeout", async () => {
    const fixture = createAccountFixture();
    const loadActivationProgress = vi
      .fn()
      .mockResolvedValue(activationSnapshot({ activationStatus: "pending" }));
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        activationStream: {
          heartbeatIntervalMs: 5,
          maxConnectionMs: 15,
          pollIntervalMs: 5,
          retryAfterMs: 250,
        },
        sessions: {
          loadActivationProgress,
          loadSummary: vi.fn(),
        },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const response = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/activation/events`,
      { headers: { cookie: cookie.header } },
    );
    const body = await response.text();

    expect(body).toContain("event: heartbeat");
    expect(body).toContain("event: reconnect");
    expect(body).toContain('"retryAfterMs":250');
  });
});

describe("lesson regeneration endpoint", () => {
  const sessionId = "71000000-0000-4000-8000-000000000071";
  const courseId = "71000000-0000-4000-8000-000000000072";
  const requestId = "71000000-0000-4000-8000-000000000073";

  it("requires CSRF and forwards one owner-scoped idempotent request", async () => {
    const fixture = createAccountFixture();
    const regenerateLesson = vi.fn().mockResolvedValue({
      operation: {
        attemptCount: 0,
        id: "71000000-0000-4000-8000-000000000074",
        regenerationOrdinal: 1,
        status: "queued",
      },
      replayed: false,
    });
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        sessions: {
          loadSummary: vi.fn(),
          regenerateLesson,
        },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const url = `${baseUrl}/v1/study-sessions/${sessionId}/activation/regenerate`;
    const preflight = await fetch(url, {
      headers: {
        "access-control-request-headers":
          "content-type,idempotency-key,x-reflo-csrf",
        "access-control-request-method": "POST",
        origin: "https://app.reflo.example",
      },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "idempotency-key",
    );
    const denied = await fetch(url, {
      body: JSON.stringify({ courseId }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        "idempotency-key": requestId,
        origin: "https://app.reflo.example",
      },
      method: "POST",
    });
    expect(denied.status).toBe(403);

    const accepted = await fetch(url, {
      body: JSON.stringify({ courseId }),
      headers: {
        "content-type": "application/json",
        cookie: cookie.header,
        "idempotency-key": requestId,
        origin: "https://app.reflo.example",
        "x-reflo-csrf": cookie.csrf,
      },
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      regeneration: {
        attemptCount: 0,
        maxAttempts: 5,
        operationId: "71000000-0000-4000-8000-000000000074",
        regenerationOrdinal: 1,
        replayed: false,
        status: "queued",
      },
    });
    expect(regenerateLesson).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      sessionId,
      courseId,
      requestId,
    );
  });

  it("returns bounded cooldown and scope-denial responses", async () => {
    const fixture = createAccountFixture();
    const retryAt = new Date(Date.now() + 30_000);
    const regenerateLesson = vi
      .fn()
      .mockRejectedValueOnce(
        new ActivationGenerationError("regeneration_cooldown", undefined, {
          retryAt,
        }),
      )
      .mockRejectedValueOnce(
        new ActivationGenerationError("authorization_denied"),
      );
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      { sessions: { loadSummary: vi.fn(), regenerateLesson } },
    );
    const cookie = await login(baseUrl, fixture.email);
    const request = () =>
      fetch(`${baseUrl}/v1/study-sessions/${sessionId}/activation/regenerate`, {
        body: JSON.stringify({ courseId }),
        headers: {
          "content-type": "application/json",
          cookie: cookie.header,
          "idempotency-key": requestId,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      });
    const cooldown = await request();
    expect(cooldown.status).toBe(429);
    expect(Number(cooldown.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await cooldown.json()).toMatchObject({
      error: "regeneration_cooldown",
    });
    expect((await request()).status).toBe(404);
  });
});

describe("assessment regeneration endpoint", () => {
  it("forwards the typed assessment kind with owner scope and idempotency", async () => {
    const fixture = createAccountFixture();
    const regenerateAssessment = vi.fn().mockResolvedValue({
      operation: {
        attemptCount: 0,
        id: "72000000-0000-4000-8000-000000000074",
        regenerationOrdinal: 1,
        status: "queued",
      },
      replayed: false,
    });
    const { baseUrl } = await startAccountServer(
      fixture.service,
      undefined,
      undefined,
      {
        sessions: { loadSummary: vi.fn(), regenerateAssessment },
      },
    );
    const cookie = await login(baseUrl, fixture.email);
    const sessionId = "72000000-0000-4000-8000-000000000071";
    const courseId = "72000000-0000-4000-8000-000000000072";
    const requestId = "72000000-0000-4000-8000-000000000073";
    const response = await fetch(
      `${baseUrl}/v1/study-sessions/${sessionId}/assessments/chapter_quiz/regenerate`,
      {
        body: JSON.stringify({ courseId }),
        headers: {
          "content-type": "application/json",
          cookie: cookie.header,
          "idempotency-key": requestId,
          origin: "https://app.reflo.example",
          "x-reflo-csrf": cookie.csrf,
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      regeneration: { artifactKind: "chapter_quiz", maxAttempts: 5 },
    });
    expect(regenerateAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ ownerScopeId: expect.any(String) }),
      sessionId,
      courseId,
      "chapter_quiz",
      requestId,
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

function activationSnapshot(
  overrides: Partial<ConnectedActivationProgress> = {},
): ConnectedActivationProgress {
  return {
    activationStatus: "pending",
    artifact: "first_text_lesson",
    assessmentStatus: "pending",
    attemptCount: 0,
    contractVersion: "activation-progress-v1",
    failure: null,
    maxAttempts: 5,
    nextAction: "wait",
    stage: "awaiting_generation",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
