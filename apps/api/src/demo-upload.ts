import { createHash, randomUUID } from "node:crypto";

import type {
  DemoCourseOutline,
  DemoSourceApproval,
  DemoUploadFailureCode,
  DemoUploadState,
  DemoUploadView,
} from "@reflo/contracts";
import { DEMO_UPLOAD_CONTRACT_VERSION } from "@reflo/contracts";
import type {
  DemoUploadCreate,
  DemoUploadGenerationClaim,
  DemoUploadGenerationFailure,
  DemoUploadOutlineSnapshot,
  DemoUploadProcessingWorkRecord,
  DemoUploadSnapshot,
} from "@reflo/db";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

const STANDARD_MAX_BYTES = 20 * 1024 * 1024;
const STANDARD_MAX_PAGES = 200;

export const APPROVED_AGENTS_COURSE_SOURCE = Object.freeze({
  approvalId: "hf-agents-course-core-units-1-4-v1",
  attribution: "Hugging Face Agents Course contributors",
  byteSize: 478_301,
  contractVersion: DEMO_UPLOAD_CONTRACT_VERSION,
  extension: "pdf",
  humanApprovalReference:
    "https://github.com/deepessh/reflo-learning/issues/36",
  licenseLabel: "Apache-2.0",
  mediaType: "application/pdf",
  sha256: "0cf0a55563ecc7efb2bcb8dc04b942f31a4fb1ac482a664ff7bae3d0e15d7ca9",
  sourceRevision: "8c0832eae634ebb34541c65265caa6da4c5d2c57",
  title: "Hugging Face Agents Course core Units 1–4",
} as const satisfies ApprovedDemoSource);

export interface ApprovedDemoSource extends DemoSourceApproval {
  readonly byteSize: number;
  readonly humanApprovalReference: string;
  readonly sha256: string;
}

export interface DemoUploadPersistence {
  create(input: DemoUploadCreate): Promise<void>;
  claimCourseGeneration(
    work: DemoUploadProcessingWork,
  ): Promise<DemoUploadGenerationClaim>;
  completeCourseGeneration(work: DemoUploadProcessingWork): Promise<void>;
  failCourseGenerationAttempt(
    work: DemoUploadProcessingWork,
    failure: DemoUploadGenerationFailure,
  ): Promise<"failed" | "retry_scheduled">;
  get(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadSnapshot | null>;
  getProcessingWork(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadProcessingWorkRecord | null>;
  listRecoverable(
    authorization: ScopeAuthorizationContext,
  ): Promise<readonly DemoUploadProcessingWorkRecord[]>;
  loadOutline(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadOutlineSnapshot | null>;
}

export interface DemoUploadProcessingWork {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly expectedInputSha256: string;
  readonly generationOperationId: string;
  readonly operationId: string;
  readonly sourceDocumentId: string;
}

export interface DemoUploadProcessingQueue {
  schedule(work: DemoUploadProcessingWork): void;
}

export interface DemoUploadObjectStore {
  putIfAbsent(input: {
    readonly bytes: Uint8Array;
    readonly objectKey: string;
    readonly sha256: string;
  }): Promise<{
    readonly byteLength: number;
    readonly objectKey: string;
    readonly sha256: string;
  }>;
}

export class DemoUploadAccessError extends Error {
  constructor(readonly code: "authorization_denied" | "not_found") {
    super(code);
    this.name = "DemoUploadAccessError";
  }
}

export class ApprovedDemoUploadService {
  readonly #approvals: ReadonlyMap<string, ApprovedDemoSource>;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #objects: DemoUploadObjectStore;
  readonly #operatorUserIds: ReadonlySet<string>;
  readonly #processing: DemoUploadProcessingQueue | undefined;
  readonly #repository: DemoUploadPersistence;

  constructor(options: {
    readonly approvals: readonly ApprovedDemoSource[];
    readonly clock?: () => Date;
    readonly createId?: () => string;
    readonly objects: DemoUploadObjectStore;
    readonly operatorUserIds: readonly string[];
    readonly processing?: DemoUploadProcessingQueue;
    readonly repository: DemoUploadPersistence;
  }) {
    this.#approvals = new Map(
      options.approvals.map((approval) => [
        approval.approvalId,
        validateApproval(approval),
      ]),
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#objects = options.objects;
    this.#operatorUserIds = new Set(options.operatorUserIds);
    this.#processing = options.processing;
    this.#repository = options.repository;
    if (
      this.#approvals.size !== options.approvals.length ||
      this.#approvals.size < 1 ||
      this.#operatorUserIds.size !== options.operatorUserIds.length ||
      this.#operatorUserIds.size < 1 ||
      [...this.#operatorUserIds].some((id) => !isUuid(id))
    ) {
      throw new Error("demo upload configuration is invalid");
    }
  }

  async listApprovals(
    authorization: ScopeAuthorizationContext,
  ): Promise<readonly DemoSourceApproval[]> {
    this.#assertOperator(authorization);
    return [...this.#approvals.values()].map(publicApproval);
  }

  async create(
    authorization: ScopeAuthorizationContext,
    input: {
      readonly approvalId: string;
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly replacesUploadId?: string;
    },
  ): Promise<DemoUploadView> {
    this.#assertOperator(authorization);
    const uploadId = this.#createId();
    if (input.mediaType !== "application/pdf") {
      return failedUpload(
        uploadId,
        input.approvalId,
        "unsupported_type",
        this.#clock(),
      );
    }
    const approval = this.#approvals.get(input.approvalId);
    const actualSha256 = sha256(input.bytes);
    if (
      approval === undefined ||
      actualSha256 !== approval.sha256 ||
      input.bytes.byteLength !== approval.byteSize
    ) {
      return failedUpload(
        uploadId,
        input.approvalId,
        "source_not_approved",
        this.#clock(),
      );
    }
    if (input.mediaType !== approval.mediaType) {
      return failedUpload(
        uploadId,
        approval.approvalId,
        "mime_mismatch",
        this.#clock(),
      );
    }
    if (input.replacesUploadId !== undefined) {
      const replaced = await this.#repository.get(
        authorization,
        input.replacesUploadId,
      );
      if (
        replaced === null ||
        replaced.checksum !== actualSha256 ||
        uploadState(replaced, processingLane(replaced)) !== "failed" ||
        !isRetryableFailureClass(replaced.failureClass)
      ) {
        throw new DemoUploadAccessError("not_found");
      }
    }
    const courseId = this.#createId();
    const operationId = this.#createId();
    const generationOperationId = this.#createId();
    const objectKey = `owners/${authorization.ownerScopeId}/sources/${uploadId}/versions/v1/original.${approval.extension}`;
    const stored = await this.#objects.putIfAbsent({
      bytes: input.bytes,
      objectKey,
      sha256: actualSha256,
    });
    if (
      stored.objectKey !== objectKey ||
      stored.byteLength !== input.bytes.byteLength ||
      stored.sha256 !== actualSha256
    ) {
      throw new Error("demo_upload_storage_mismatch");
    }
    await this.#repository.create({
      authorization,
      byteSize: input.bytes.byteLength,
      checksum: actualSha256,
      courseId,
      generationOperationId,
      mediaType: approval.mediaType,
      objectKey,
      operationId,
      replacesSourceDocumentId: input.replacesUploadId,
      sourceDocumentId: uploadId,
      title: approval.title,
    });
    const snapshot = await this.#repository.get(authorization, uploadId);
    if (
      snapshot === null ||
      snapshot.sourceDocumentId !== uploadId ||
      snapshot.courseId !== courseId ||
      snapshot.checksum !== actualSha256
    ) {
      throw new Error("demo_upload_persistence_mismatch");
    }
    const view = this.#project(snapshot, approval);
    this.#processing?.schedule({
      authorization,
      courseId,
      expectedInputSha256: actualSha256,
      generationOperationId,
      operationId,
      sourceDocumentId: uploadId,
    });
    return view;
  }

  async get(
    authorization: ScopeAuthorizationContext,
    uploadId: string,
  ): Promise<DemoUploadView | null> {
    this.#assertOperator(authorization);
    const snapshot = await this.#repository.get(authorization, uploadId);
    if (snapshot === null) {
      return null;
    }
    const recoverable = await this.#repository.getProcessingWork(
      authorization,
      uploadId,
    );
    if (recoverable !== null) {
      this.#processing?.schedule(recoverable);
    }
    const approval = [...this.#approvals.values()].find(
      (candidate) => candidate.sha256 === snapshot.checksum,
    );
    return approval === undefined ? null : this.#project(snapshot, approval);
  }

  async loadOutline(
    authorization: ScopeAuthorizationContext,
    uploadId: string,
  ): Promise<DemoCourseOutline | null> {
    this.#assertOperator(authorization);
    const snapshot = await this.#repository.get(authorization, uploadId);
    if (
      snapshot === null ||
      ![...this.#approvals.values()].some(
        (approval) => approval.sha256 === snapshot.checksum,
      )
    ) {
      return null;
    }
    const outline = await this.#repository.loadOutline(authorization, uploadId);
    return outline === null
      ? null
      : {
          ...outline,
          contractVersion: DEMO_UPLOAD_CONTRACT_VERSION,
          generatedAt: outline.generatedAt.toISOString(),
          uploadId,
        };
  }

  #assertOperator(authorization: ScopeAuthorizationContext): void {
    if (!this.#operatorUserIds.has(authorization.actorId)) {
      throw new DemoUploadAccessError("authorization_denied");
    }
  }

  #project(
    snapshot: DemoUploadSnapshot,
    approval: ApprovedDemoSource,
  ): DemoUploadView {
    const lane = processingLane(snapshot);
    const state = uploadState(snapshot, lane);
    const failureCode =
      state === "failed" ? mapFailure(snapshot.failureClass) : null;
    return {
      approvalId: approval.approvalId,
      contractVersion: DEMO_UPLOAD_CONTRACT_VERSION,
      courseId: snapshot.courseId,
      failure:
        failureCode === null
          ? null
          : {
              code: failureCode,
              retryable: isRetryableFailureClass(snapshot.failureClass),
            },
      processingLane: lane,
      state,
      statusUpdatedAt: snapshot.updatedAt.toISOString(),
      uploadId: snapshot.sourceDocumentId,
    };
  }
}

function isRetryableFailureClass(value: string | null): boolean {
  return (
    value === "infrastructure_unavailable" ||
    value === "generation_dependency_unavailable"
  );
}

function processingLane(snapshot: DemoUploadSnapshot): "large" | "standard" {
  return snapshot.byteSize > STANDARD_MAX_BYTES ||
    (snapshot.pageCount ?? 0) > STANDARD_MAX_PAGES ||
    snapshot.parseStatus === "ocr_required"
    ? "large"
    : "standard";
}

function uploadState(
  snapshot: DemoUploadSnapshot,
  processingLane: "large" | "standard",
): DemoUploadState {
  if (
    snapshot.courseStatus === "ready" &&
    snapshot.activeCurriculumGenerationId !== null
  ) {
    return "outline_ready";
  }
  if (
    snapshot.courseStatus === "failed" ||
    snapshot.parseStatus === "failed" ||
    snapshot.operationState === "failed_permanent" ||
    snapshot.operationState === "cancelled" ||
    snapshot.operationState === "expired"
  ) {
    return "failed";
  }
  if (snapshot.parseStatus === "ocr_required") {
    return "ocr_required";
  }
  if (processingLane === "large") {
    return "large_document";
  }
  switch (snapshot.parseStatus) {
    case "quarantined":
      return "accepted";
    case "validating":
      return "validating";
    case "queued":
      return "queued";
    case "parsing":
      return "parsing";
    case "parsed":
      return "generating_outline";
  }
}

function mapFailure(value: string | null): DemoUploadFailureCode {
  switch (value) {
    case "active_content":
      return "active_content";
    case "archive_limit":
      return "archive_limit";
    case "encrypted":
      return "encrypted";
    case "malformed_document":
    case "invalid_output":
      return "malformed_document";
    case "malware_detected":
      return "malware_detected";
    case "mime_mismatch":
      return "mime_mismatch";
    case "page_limit":
    case "parse_oom":
      return "over_limit";
    case "unsupported_type":
      return "unsupported_type";
    case "infrastructure_unavailable":
    case "generation_dependency_unavailable":
    case "scan_db_stale":
      return "dependency_unavailable";
    case "generation_authorization_denied":
    case "generation_deadline_exceeded":
    case "generation_invalid_result":
    case "curriculum_generation_failed":
      return "generation_failed";
    case "parse_timeout":
    case "parser_crash":
    case null:
    default:
      return "parser_failed";
  }
}

function failedUpload(
  uploadId: string,
  approvalId: string,
  code: DemoUploadFailureCode,
  now: Date,
): DemoUploadView {
  return {
    approvalId,
    contractVersion: DEMO_UPLOAD_CONTRACT_VERSION,
    courseId: null,
    failure: { code, retryable: false },
    processingLane: null,
    state: "failed",
    statusUpdatedAt: now.toISOString(),
    uploadId,
  };
}

function publicApproval(approval: ApprovedDemoSource): DemoSourceApproval {
  return {
    approvalId: approval.approvalId,
    attribution: approval.attribution,
    contractVersion: approval.contractVersion,
    extension: approval.extension,
    licenseLabel: approval.licenseLabel,
    mediaType: approval.mediaType,
    sourceRevision: approval.sourceRevision,
    title: approval.title,
  };
}

function validateApproval(approval: ApprovedDemoSource): ApprovedDemoSource {
  if (
    !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(approval.approvalId) ||
    approval.contractVersion !== DEMO_UPLOAD_CONTRACT_VERSION ||
    approval.extension !== "pdf" ||
    approval.mediaType !== "application/pdf" ||
    !/^[a-f0-9]{40}$/.test(approval.sourceRevision) ||
    !/^[a-f0-9]{64}$/.test(approval.sha256) ||
    !Number.isSafeInteger(approval.byteSize) ||
    approval.byteSize < 1 ||
    approval.humanApprovalReference.length < 1
  ) {
    throw new Error("demo source approval is invalid");
  }
  return approval;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
