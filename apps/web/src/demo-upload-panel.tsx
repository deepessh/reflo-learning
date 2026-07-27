"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import type {
  DemoCourseOutline,
  DemoSourceApproval,
  DemoUploadView,
} from "@reflo/contracts";

import { demoUploadPresentation } from "./demo-upload-view";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type ApprovalScreen = "error" | "hidden" | "loading" | "ready";
type SubmissionScreen = "idle" | "submitting" | "tracking";

export function DemoUploadPanel({
  apiOrigin,
  onCourseReady,
}: {
  readonly apiOrigin: string;
  readonly onCourseReady: (courseId: string) => void;
}) {
  const [approvalScreen, setApprovalScreen] =
    useState<ApprovalScreen>("loading");
  const [approvals, setApprovals] = useState<readonly DemoSourceApproval[]>([]);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submissionScreen, setSubmissionScreen] =
    useState<SubmissionScreen>("idle");
  const [upload, setUpload] = useState<DemoUploadView | null>(null);
  const [outline, setOutline] = useState<DemoCourseOutline | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    setApprovalScreen("loading");
    const response = await fetch(`${apiOrigin}/v1/demo/uploads/approvals`, {
      credentials: "include",
    }).catch(() => null);
    if (response?.status === 404) {
      setApprovalScreen("hidden");
      return;
    }
    if (response === null || !response.ok) {
      setApprovalScreen("error");
      return;
    }
    const body = (await response.json()) as {
      approvals: readonly DemoSourceApproval[];
    };
    setApprovals(body.approvals);
    setSelectedApprovalId(body.approvals[0]?.approvalId ?? "");
    setApprovalScreen("ready");
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadApprovals(), 0);
    return () => window.clearTimeout(timer);
  }, [loadApprovals]);

  useEffect(() => {
    if (upload === null) {
      return;
    }
    const presentation = demoUploadPresentation(
      upload.state,
      upload.failure?.code ?? null,
    );
    if (!presentation.poll) {
      return;
    }
    const timer = window.setTimeout(async () => {
      const response = await fetch(
        `${apiOrigin}/v1/demo/uploads/${encodeURIComponent(upload.uploadId)}`,
        { credentials: "include" },
      ).catch(() => null);
      if (response?.ok) {
        const body = (await response.json()) as { upload: DemoUploadView };
        setUpload(body.upload);
      } else {
        setLocalError(
          "Upload status is unavailable. No successful outcome was assumed.",
        );
      }
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [apiOrigin, upload]);

  useEffect(() => {
    if (upload?.state !== "outline_ready" || outline !== null) {
      return;
    }
    const timer = window.setTimeout(async () => {
      const response = await fetch(
        `${apiOrigin}/v1/demo/uploads/${encodeURIComponent(upload.uploadId)}/outline`,
        { credentials: "include" },
      ).catch(() => null);
      if (response?.ok) {
        const body = (await response.json()) as {
          outline: DemoCourseOutline;
        };
        setOutline(body.outline);
        setSubmissionScreen("tracking");
      } else {
        setLocalError(
          "The outline reference is not available. No generated course was opened.",
        );
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [apiOrigin, outline, upload]);

  if (approvalScreen === "hidden") {
    return null;
  }

  const approval = approvals.find(
    (candidate) => candidate.approvalId === selectedApprovalId,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setOutline(null);
    if (approval === undefined || file === null) {
      setLocalError("Choose an approved source and its exact local artifact.");
      return;
    }
    if (
      file.size < 1 ||
      file.size > MAX_UPLOAD_BYTES ||
      fileExtension(file.name) !== approval.extension ||
      (file.type !== "" && file.type !== approval.mediaType)
    ) {
      setLocalError(
        "The selected file does not match the approved type or 50 MB limit.",
      );
      return;
    }
    setSubmissionScreen("submitting");
    const csrfResponse = await fetch(`${apiOrigin}/v1/csrf-token`, {
      credentials: "include",
    }).catch(() => null);
    if (csrfResponse === null || !csrfResponse.ok) {
      setSubmissionScreen("idle");
      setLocalError("Upload authorization is unavailable. Sign in and retry.");
      return;
    }
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
    const response = await fetch(`${apiOrigin}/v1/demo/uploads`, {
      body: file,
      credentials: "include",
      headers: {
        "content-type": approval.mediaType,
        "x-reflo-csrf": csrfToken,
        "x-reflo-demo-source-approval": approval.approvalId,
      },
      method: "POST",
    }).catch(() => null);
    if (response === null || !response.ok) {
      setSubmissionScreen("idle");
      setLocalError(
        response?.status === 413
          ? "The selected file exceeds the 50 MB product maximum."
          : "The upload was not accepted. No successful outcome was recorded.",
      );
      return;
    }
    const body = (await response.json()) as { upload: DemoUploadView };
    setUpload(body.upload);
    setSubmissionScreen("tracking");
  }

  const presentation =
    upload === null
      ? null
      : demoUploadPresentation(upload.state, upload.failure?.code ?? null);

  return (
    <section
      className="panel demo-upload-panel"
      aria-labelledby="demo-upload-title"
    >
      <div className="panel-heading demo-upload-heading">
        <div>
          <p className="eyebrow">Staff operator · separate SLO proof</p>
          <h2 id="demo-upload-title">Approved source to course outline</h2>
          <p>
            This surface accepts only configured, human-approved demo sources.
            It demonstrates upload to outline; lessons, quizzes, and media
            generate separately.
          </p>
        </div>
        <span className="demo-boundary">No public or learner uploads</span>
      </div>

      {approvalScreen === "loading" ? (
        <p className="upload-loading">Loading approved demo sources…</p>
      ) : null}
      {approvalScreen === "error" ? (
        <div className="upload-state tone-negative">
          <strong>Operator upload unavailable</strong>
          <p>
            The approved-source dependency could not be verified. No upload is
            enabled.
          </p>
          <button
            className="secondary-button"
            onClick={() => void loadApprovals()}
            type="button"
          >
            Retry approval check
          </button>
        </div>
      ) : null}
      {approvalScreen === "ready" && approvals.length === 0 ? (
        <div className="upload-state tone-attention">
          <strong>No approved sources configured</strong>
          <p>
            Upload stays disabled until a human-approved rights record is
            available.
          </p>
        </div>
      ) : null}
      {approvalScreen === "ready" && approvals.length > 0 ? (
        <>
          <form className="demo-upload-form" onSubmit={submit}>
            <label htmlFor="demo-source-approval">Approved source</label>
            <select
              id="demo-source-approval"
              onChange={(event) => {
                setSelectedApprovalId(event.target.value);
                setFile(null);
                setUpload(null);
                setOutline(null);
                setLocalError(null);
              }}
              value={selectedApprovalId}
            >
              {approvals.map((candidate) => (
                <option key={candidate.approvalId} value={candidate.approvalId}>
                  {candidate.title} · {candidate.licenseLabel}
                </option>
              ))}
            </select>
            {approval === undefined ? null : (
              <p className="approval-evidence">
                {approval.attribution} · revision {approval.sourceRevision} ·{" "}
                {approval.extension.toUpperCase()}
              </p>
            )}
            <label htmlFor="demo-source-file">Exact approved artifact</label>
            <input
              accept={approval?.mediaType}
              id="demo-source-file"
              key={selectedApprovalId}
              onChange={(event) =>
                setFile(event.currentTarget.files?.[0] ?? null)
              }
              required
              type="file"
            />
            <button disabled={submissionScreen === "submitting"} type="submit">
              {submissionScreen === "submitting"
                ? "Uploading…"
                : "Validate and build outline"}
            </button>
          </form>

          {localError === null ? null : (
            <p className="upload-local-error" role="alert">
              {localError}
            </p>
          )}
          {presentation === null ? null : (
            <div
              className={`upload-state tone-${presentation.tone}`}
              aria-live="polite"
            >
              <strong>{presentation.label}</strong>
              <p>{presentation.detail}</p>
              <small>
                Updated {new Date(upload!.statusUpdatedAt).toLocaleTimeString()}
              </small>
            </div>
          )}
          {outline === null ? null : (
            <div className="uploaded-outline">
              <div>
                <p className="eyebrow">Owner-scoped generated outline</p>
                <h3>{outline.title}</h3>
              </div>
              <ol>
                {outline.chapters.map((chapter) => (
                  <li key={chapter.chapterId}>
                    <strong>
                      {chapter.order}. {chapter.title}
                    </strong>
                    <span>
                      {chapter.concepts.length} source-backed concepts
                    </span>
                  </li>
                ))}
              </ol>
              <button
                className="secondary-button"
                onClick={() => onCourseReady(outline.courseId)}
                type="button"
              >
                Open generated course
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
  return match?.[1] ?? "";
}
