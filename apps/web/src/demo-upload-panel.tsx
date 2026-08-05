"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  DemoCourseOutline,
  DemoSourceApproval,
  DemoUploadView,
} from "@reflo/contracts";

import {
  DEMO_UPLOAD_FILE_ACCEPT,
  isDemoPdfSelection,
} from "./demo-upload-file";
import {
  demoUploadFailureAction,
  demoUploadPresentation,
} from "./demo-upload-view";

type ApprovalScreen = "error" | "hidden" | "loading" | "ready";
type SubmissionScreen = "idle" | "submitting" | "tracking";

const STATUS_UNAVAILABLE_COPY =
  "Upload status is temporarily unavailable. Reflo will keep checking; no successful outcome was assumed.";
const STATUS_POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

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
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const submitGuard = useRef(false);

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
    let consecutiveFailures = 0;
    let controller: AbortController | null = null;
    let stopped = false;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      controller = new AbortController();
      let response: Response | null = null;
      try {
        response = await fetch(
          `${apiOrigin}/v1/demo/uploads/${encodeURIComponent(upload.uploadId)}`,
          { credentials: "include", signal: controller.signal },
        );
      } catch {
        response = null;
      }
      if (stopped) {
        return;
      }
      if (response?.ok) {
        try {
          const body = (await response.json()) as { upload: DemoUploadView };
          if (stopped) {
            return;
          }
          consecutiveFailures = 0;
          setUpload(body.upload);
          setLastCheckedAt(new Date().toISOString());
          submitGuard.current = demoUploadPresentation(
            body.upload.state,
            body.upload.failure?.code ?? null,
          ).formLocked;
          setLocalError((current) =>
            current === STATUS_UNAVAILABLE_COPY ? null : current,
          );
          if (
            demoUploadPresentation(
              body.upload.state,
              body.upload.failure?.code ?? null,
            ).poll
          ) {
            schedule(STATUS_POLL_DELAYS_MS[0]);
          }
          return;
        } catch {
          response = null;
        }
      }
      setLocalError(STATUS_UNAVAILABLE_COPY);
      consecutiveFailures += 1;
      schedule(
        STATUS_POLL_DELAYS_MS[
          Math.min(consecutiveFailures, STATUS_POLL_DELAYS_MS.length) - 1
        ]!,
      );
    };

    schedule(STATUS_POLL_DELAYS_MS[0]);
    return () => {
      stopped = true;
      controller?.abort();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
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
  const presentation =
    upload === null
      ? null
      : demoUploadPresentation(upload.state, upload.failure?.code ?? null);
  const failureAction =
    upload === null ? null : demoUploadFailureAction(upload);
  const isBusy =
    submissionScreen === "submitting" || presentation?.poll === true;
  const formLocked =
    submissionScreen === "submitting" || presentation?.formLocked === true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitGuard.current || formLocked) {
      return;
    }
    submitGuard.current = true;
    setLocalError(null);
    setOutline(null);
    if (approval === undefined || file === null) {
      submitGuard.current = false;
      setLocalError("Choose an approved source and the matching PDF file.");
      return;
    }
    if (!isDemoPdfSelection(file)) {
      submitGuard.current = false;
      setLocalError(
        "Choose the matching approved PDF within the 50 MB limit. Other file types are not supported yet.",
      );
      return;
    }
    setLastCheckedAt(null);
    setSubmissionScreen("submitting");
    const csrfResponse = await fetch(`${apiOrigin}/v1/csrf-token`, {
      credentials: "include",
    }).catch(() => null);
    if (csrfResponse === null || !csrfResponse.ok) {
      submitGuard.current = false;
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
        ...(failureAction?.replacesUploadId !== null &&
        failureAction?.replacesUploadId !== undefined
          ? {
              "x-reflo-demo-upload-retry-of": failureAction.replacesUploadId,
            }
          : {}),
      },
      method: "POST",
    }).catch(() => null);
    if (response === null || !response.ok) {
      submitGuard.current = false;
      setSubmissionScreen("idle");
      setLocalError(
        response?.status === 413
          ? "The selected file exceeds the 50 MB product maximum."
          : response?.status === 415
            ? "Course setup currently accepts only the matching approved PDF."
            : "The upload was not accepted. Check the file and try again.",
      );
      return;
    }
    const body = (await response.json()) as { upload: DemoUploadView };
    setUpload(body.upload);
    setLastCheckedAt(new Date().toISOString());
    setSubmissionScreen("tracking");
    submitGuard.current = demoUploadPresentation(
      body.upload.state,
      body.upload.failure?.code ?? null,
    ).formLocked;
  }

  return (
    <section
      className="panel demo-upload-panel"
      aria-busy={isBusy}
      aria-labelledby="demo-upload-title"
    >
      <div className="panel-heading demo-upload-heading">
        <div>
          <p className="eyebrow">Course setup</p>
          <h2 id="demo-upload-title">Build a course from a PDF</h2>
          <p>
            Choose an approved source and the matching PDF. Reflo will validate
            it and build a source-backed course outline; lessons, quizzes, and
            audio may continue preparing afterward.
          </p>
        </div>
        <span className="source-boundary">Approved sources only</span>
      </div>

      {approvalScreen === "loading" ? (
        <p className="upload-loading" role="status">
          Loading approved sources…
        </p>
      ) : null}
      {approvalScreen === "error" ? (
        <div className="upload-state tone-negative">
          <strong>Course setup is temporarily unavailable</strong>
          <p>
            Approved sources could not be loaded. Your existing courses are
            unaffected.
          </p>
          <button
            className="secondary-button"
            onClick={() => void loadApprovals()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {approvalScreen === "ready" && approvals.length === 0 ? (
        <div className="upload-state tone-attention">
          <strong>No approved sources configured</strong>
          <p>
            Course setup becomes available when an approved source is added.
          </p>
        </div>
      ) : null}
      {approvalScreen === "ready" && approvals.length > 0 ? (
        <>
          <form
            className="demo-upload-form"
            aria-busy={isBusy}
            onSubmit={submit}
          >
            <label htmlFor="demo-source-approval">Approved PDF</label>
            <select
              disabled={formLocked}
              id="demo-source-approval"
              onChange={(event) => {
                setSelectedApprovalId(event.target.value);
                setFile(null);
                setUpload(null);
                setOutline(null);
                setLocalError(null);
                setLastCheckedAt(null);
                setSubmissionScreen("idle");
                submitGuard.current = false;
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
            <label htmlFor="demo-source-file">Matching PDF file</label>
            <input
              accept={DEMO_UPLOAD_FILE_ACCEPT}
              disabled={formLocked}
              id="demo-source-file"
              key={selectedApprovalId}
              onChange={(event) =>
                setFile(event.currentTarget.files?.[0] ?? null)
              }
              required
              type="file"
            />
            <button disabled={formLocked} type="submit">
              {submissionScreen === "submitting"
                ? "Uploading…"
                : presentation?.poll
                  ? "Processing…"
                  : upload?.state === "outline_ready"
                    ? "Outline ready"
                    : upload?.state === "ocr_required"
                      ? "Validate another PDF"
                      : failureAction !== null
                        ? failureAction.label
                        : "Validate and build outline"}
            </button>
          </form>

          {localError === null ? null : (
            <p className="upload-local-error" role="alert">
              {localError}
            </p>
          )}
          {presentation === null ? null : (
            <div className={`upload-state tone-${presentation.tone}`}>
              <div
                aria-atomic="true"
                role={upload?.state === "failed" ? "alert" : "status"}
              >
                <strong>{presentation.label}</strong>
                <p>{presentation.detail}</p>
                <p>{presentation.progress}</p>
              </div>
              <small>
                Status changed at{" "}
                {new Date(upload!.statusUpdatedAt).toLocaleTimeString()}.
                {lastCheckedAt === null
                  ? ""
                  : ` Last checked at ${new Date(lastCheckedAt).toLocaleTimeString()}.`}
              </small>
            </div>
          )}
          {outline === null ? null : (
            <div className="uploaded-outline">
              <div>
                <p className="eyebrow">Course outline</p>
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
