import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  DemoUploadCreate,
  DemoUploadOutlineSnapshot,
  DemoUploadSnapshot,
} from "@reflo/db";

import {
  ApprovedDemoUploadService,
  DemoUploadAccessError,
  type ApprovedDemoSource,
  type DemoUploadPersistence,
} from "./demo-upload";

const ids = {
  course: "55000000-0000-4000-8000-000000000002",
  generationOperation: "55000000-0000-4000-8000-000000000007",
  operation: "55000000-0000-4000-8000-000000000003",
  scope: "55000000-0000-4000-8000-000000000004",
  session: "55000000-0000-4000-8000-000000000005",
  upload: "55000000-0000-4000-8000-000000000001",
  user: "55000000-0000-4000-8000-000000000006",
} as const;
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const approval = Object.freeze({
  approvalId: "approved-pdf-v1",
  attribution: "Synthetic fixture author",
  byteSize: bytes.byteLength,
  contractVersion: "demo-upload-v1",
  extension: "pdf",
  humanApprovalReference: "issue-36-owner-verdict",
  licenseLabel: "CC0-1.0",
  mediaType: "application/pdf",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sourceRevision: "a".repeat(40),
  title: "Approved synthetic fixture",
} as const satisfies ApprovedDemoSource);
const authorization = {
  actorId: ids.user,
  authorizationId: ids.session,
  ownerScopeId: ids.scope,
};

describe("approved staff demo upload service", () => {
  it("hides approvals and upload mutations from non-operator identities", async () => {
    const fixture = createFixture();
    const denied = { ...authorization, actorId: ids.scope };

    await expect(fixture.service.listApprovals(denied)).rejects.toEqual(
      new DemoUploadAccessError("authorization_denied"),
    );
    await expect(
      fixture.service.create(denied, {
        approvalId: approval.approvalId,
        bytes,
        mediaType: approval.mediaType,
      }),
    ).rejects.toBeInstanceOf(DemoUploadAccessError);
    expect(fixture.repository.create).not.toHaveBeenCalled();
  });

  it("persists only the exact approved bytes under the authenticated owner scope", async () => {
    const rejectedFixture = createFixture();
    expect(await rejectedFixture.service.listApprovals(authorization)).toEqual([
      {
        approvalId: approval.approvalId,
        attribution: approval.attribution,
        contractVersion: approval.contractVersion,
        extension: approval.extension,
        licenseLabel: approval.licenseLabel,
        mediaType: approval.mediaType,
        sourceRevision: approval.sourceRevision,
        title: approval.title,
      },
    ]);

    const rejected = await rejectedFixture.service.create(authorization, {
      approvalId: approval.approvalId,
      bytes: new Uint8Array([...bytes, 0]),
      mediaType: approval.mediaType,
    });
    expect(rejected).toMatchObject({
      courseId: null,
      failure: { code: "source_not_approved", retryable: false },
      state: "failed",
    });
    expect(rejectedFixture.repository.create).not.toHaveBeenCalled();
    expect(rejectedFixture.objects.putIfAbsent).not.toHaveBeenCalled();

    const fixture = createFixture();
    fixture.repository.snapshot = snapshot();
    const accepted = await fixture.service.create(authorization, {
      approvalId: approval.approvalId,
      bytes,
      mediaType: approval.mediaType,
    });
    expect(accepted).toMatchObject({
      approvalId: approval.approvalId,
      courseId: ids.course,
      processingLane: "standard",
      state: "accepted",
      uploadId: ids.upload,
    });
    expect(fixture.objects.putIfAbsent).toHaveBeenCalledWith({
      bytes,
      objectKey: `owners/${ids.scope}/sources/${ids.upload}/versions/v1/original.pdf`,
      sha256: approval.sha256,
    });
    expect(fixture.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization,
        checksum: approval.sha256,
        courseId: ids.course,
        generationOperationId: ids.generationOperation,
        operationId: ids.operation,
        sourceDocumentId: ids.upload,
      }),
    );
    expect(fixture.processing.schedule).toHaveBeenCalledWith({
      authorization,
      courseId: ids.course,
      expectedInputSha256: approval.sha256,
      generationOperationId: ids.generationOperation,
      operationId: ids.operation,
      sourceDocumentId: ids.upload,
    });
  });

  it("projects asynchronous, failure, and owner-scoped outline states honestly", async () => {
    const fixture = createFixture();
    fixture.repository.snapshot = {
      ...snapshot(),
      operationState: "processing",
      parseStatus: "parsing",
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      failure: null,
      state: "parsing",
    });

    fixture.repository.snapshot = {
      ...snapshot(),
      operationState: "succeeded",
      parseStatus: "parsed",
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      failure: null,
      state: "generating_outline",
    });

    fixture.repository.snapshot = {
      ...snapshot(),
      failureClass: "infrastructure_unavailable",
      operationState: "failed_permanent",
      parseStatus: "failed",
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      failure: { code: "dependency_unavailable", retryable: true },
      state: "failed",
    });

    fixture.repository.snapshot = {
      ...snapshot(),
      failureClass: "scan_db_stale",
      operationState: "failed_permanent",
      parseStatus: "failed",
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      failure: { code: "dependency_unavailable", retryable: true },
      state: "failed",
    });

    fixture.repository.snapshot = {
      ...snapshot(),
      courseStatus: "failed",
      failureClass: "curriculum_generation_failed",
      operationState: "succeeded",
      parseStatus: "parsed",
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      failure: { code: "generation_failed", retryable: false },
      state: "failed",
    });

    fixture.repository.snapshot = {
      ...snapshot(),
      activeCurriculumGenerationId: "55000000-0000-4000-8000-00000000000a",
      courseStatus: "ready",
      operationState: "succeeded",
      parseStatus: "parsed",
    };
    fixture.repository.outline = {
      chapters: [
        {
          chapterId: "55000000-0000-4000-8000-000000000008",
          concepts: [
            {
              conceptId: "55000000-0000-4000-8000-000000000009",
              name: "Agent planning",
              sourceSpanCount: 2,
            },
          ],
          order: 1,
          title: "Foundations",
        },
      ],
      courseId: ids.course,
      generatedAt: new Date("2026-07-25T20:01:00.000Z"),
      title: approval.title,
    };
    await expect(
      fixture.service.get(authorization, ids.upload),
    ).resolves.toMatchObject({
      state: "outline_ready",
    });
    await expect(
      fixture.service.loadOutline(authorization, ids.upload),
    ).resolves.toMatchObject({
      chapters: [{ concepts: [{ sourceSpanCount: 2 }] }],
      contractVersion: "demo-upload-v1",
      uploadId: ids.upload,
    });
  });

  it("re-enqueues persisted recoverable work when status is polled", async () => {
    const fixture = createFixture();
    fixture.repository.snapshot = snapshot();
    fixture.repository.processingWork = {
      authorization,
      courseId: ids.course,
      expectedInputSha256: approval.sha256,
      generationOperationId: ids.generationOperation,
      operationId: ids.operation,
      sourceDocumentId: ids.upload,
    };

    await fixture.service.get(authorization, ids.upload);

    expect(fixture.processing.schedule).toHaveBeenCalledWith(
      fixture.repository.processingWork,
    );
  });
});

function createFixture() {
  const repository = new FakeRepository();
  const objects = {
    putIfAbsent: vi.fn(async (input) => ({
      byteLength: input.bytes.byteLength,
      objectKey: input.objectKey,
      sha256: input.sha256,
    })),
  };
  const processing = { schedule: vi.fn() };
  const generatedIds = [
    ids.upload,
    ids.course,
    ids.operation,
    ids.generationOperation,
  ];
  const service = new ApprovedDemoUploadService({
    approvals: [approval],
    clock: () => new Date("2026-07-25T20:00:00.000Z"),
    createId: () => generatedIds.shift() ?? ids.operation,
    objects,
    operatorUserIds: [ids.user],
    processing,
    repository,
  });
  return { objects, processing, repository, service };
}

class FakeRepository implements DemoUploadPersistence {
  readonly claimCourseGeneration = vi.fn(async () => ({
    deadlineMs: 960_000,
    kind: "claimed" as const,
  }));
  readonly completeCourseGeneration = vi.fn(async () => undefined);
  readonly create = vi.fn(async (_input: DemoUploadCreate) => undefined);
  readonly failCourseGenerationAttempt = vi.fn(async () => "failed" as const);
  readonly listRecoverable = vi.fn(async () => []);
  outline: DemoUploadOutlineSnapshot | null = null;
  processingWork: Awaited<
    ReturnType<DemoUploadPersistence["getProcessingWork"]>
  > = null;
  snapshot: DemoUploadSnapshot | null = null;

  async get(): Promise<DemoUploadSnapshot | null> {
    return this.snapshot;
  }

  async getProcessingWork() {
    return this.processingWork;
  }

  async loadOutline(): Promise<DemoUploadOutlineSnapshot | null> {
    return this.outline;
  }
}

function snapshot(): DemoUploadSnapshot {
  return {
    activeCurriculumGenerationId: null,
    byteSize: approval.byteSize,
    checksum: approval.sha256,
    courseId: ids.course,
    courseStatus: "generating",
    failureClass: null,
    operationState: "queued",
    pageCount: null,
    parseStatus: "quarantined",
    sourceDocumentId: ids.upload,
    title: approval.title,
    updatedAt: new Date("2026-07-25T20:00:00.000Z"),
  };
}
