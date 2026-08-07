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
  demoCourseOutlineForUpload,
  demoUploadFailureAction,
  demoUploadPresentation,
  demoUploadTrackedTarget,
} from "./demo-upload-view";

type ApprovalScreen = "error" | "hidden" | "loading" | "ready";
type SubmissionScreen = "idle" | "submitting" | "tracking";
type TrackedUploadScreen = "error" | "idle" | "loading" | "ready";

const STATUS_UNAVAILABLE_COPY =
  "Upload status is temporarily unavailable. Reflo will keep checking; no successful outcome was assumed.";
const STATUS_POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export function DemoUploadPanel({
  apiOrigin,
  onCourseReady,
  trackedUploadId,
}: {
  readonly apiOrigin: string;
  readonly onCourseReady: (courseId: string) => void;
  readonly trackedUploadId: string | null;
}) {
  const [approvalScreen, setApprovalScreen] =
    useState<ApprovalScreen>("loading");
  const [approvals, setApprovals] = useState<readonly DemoSourceApproval[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [submissionScreen, setSubmissionScreen] =
    useState<SubmissionScreen>("idle");
  const [upload, setUpload] = useState<DemoUploadView | null>(null);
  const [outline, setOutline] = useState<DemoCourseOutline | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [resolvedTrackedUploadId, setResolvedTrackedUploadId] = useState<
    string | null
  >(null);
  const [trackedUploadScreen, setTrackedUploadScreen] =
    useState<TrackedUploadScreen>("idle");
  const [trackedUploadReloadKey, setTrackedUploadReloadKey] = useState(0);
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
    setApprovalScreen("ready");
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadApprovals(), 0);
    return () => window.clearTimeout(timer);
  }, [loadApprovals]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const timer = window.setTimeout(async () => {
      setResolvedTrackedUploadId(null);
      setUpload(null);
      setOutline(null);
      setFile(null);
      setLocalError(null);
      setLastCheckedAt(null);
      setSubmissionScreen("idle");
      submitGuard.current = trackedUploadId !== null;
      if (trackedUploadId === null) {
        setTrackedUploadScreen("idle");
        return;
      }
      setTrackedUploadScreen("loading");
      controller = new AbortController();
      const response = await fetch(
        `${apiOrigin}/v1/demo/uploads/${encodeURIComponent(trackedUploadId)}`,
        { credentials: "include", signal: controller.signal },
      ).catch(() => null);
      if (controller.signal.aborted) {
        return;
      }
      if (response?.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly upload?: DemoUploadView;
        } | null;
        if (controller.signal.aborted) {
          return;
        }
        const trackedTarget =
          body?.upload === undefined
            ? null
            : demoUploadTrackedTarget(trackedUploadId, body.upload);
        if (trackedTarget !== null) {
          const trackedPresentation = demoUploadPresentation(
            trackedTarget.state,
            trackedTarget.failure?.code ?? null,
          );
          if (controller.signal.aborted) {
            return;
          }
          setUpload(trackedTarget);
          setLastCheckedAt(new Date().toISOString());
          setSubmissionScreen("tracking");
          setResolvedTrackedUploadId(trackedUploadId);
          setTrackedUploadScreen("ready");
          submitGuard.current = trackedPresentation.formLocked;
          return;
        }
      }
      if (controller.signal.aborted) {
        return;
      }
      setResolvedTrackedUploadId(trackedUploadId);
      setTrackedUploadScreen("error");
      setLocalError(
        "This upload status could not be loaded. No new course was created or assumed ready.",
      );
    }, 0);
    return () => {
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [apiOrigin, trackedUploadId, trackedUploadReloadKey]);

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
    let controller: AbortController | null = null;
    const timer = window.setTimeout(async () => {
      controller = new AbortController();
      const uploadId = upload.uploadId;
      const response = await fetch(
        `${apiOrigin}/v1/demo/uploads/${encodeURIComponent(uploadId)}/outline`,
        { credentials: "include", signal: controller.signal },
      ).catch(() => null);
      if (controller.signal.aborted) {
        return;
      }
      if (response?.ok) {
        const body = await response.json().catch(() => null);
        if (controller.signal.aborted) {
          return;
        }
        const validatedOutline = demoCourseOutlineForUpload(uploadId, body);
        if (validatedOutline !== null) {
          setOutline(validatedOutline);
          setSubmissionScreen("tracking");
        } else {
          setLocalError(
            "The outline reference is not available. No generated course was opened.",
          );
        }
      } else {
        if (controller.signal.aborted) {
          return;
        }
        setLocalError(
          "The outline reference is not available. No generated course was opened.",
        );
      }
    }, 0);
    return () => {
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [apiOrigin, outline, upload]);

  if (approvalScreen === "hidden") {
    return null;
  }

  const approval = approvals[0];
  const presentation =
    upload === null
      ? null
      : demoUploadPresentation(upload.state, upload.failure?.code ?? null);
  const failureAction =
    upload === null ? null : demoUploadFailureAction(upload);
  const trackedUploadPending =
    trackedUploadId !== null &&
    (trackedUploadScreen === "loading" ||
      resolvedTrackedUploadId !== trackedUploadId);
  const trackedUploadUnavailable = trackedUploadScreen === "error";
  const isBusy =
    submissionScreen === "submitting" ||
    presentation?.poll === true ||
    trackedUploadPending;
  const formLocked =
    submissionScreen === "submitting" ||
    presentation?.formLocked === true ||
    trackedUploadPending ||
    trackedUploadUnavailable;

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
      setLocalError("Choose a PDF file.");
      return;
    }
    if (!isDemoPdfSelection(file)) {
      submitGuard.current = false;
      setLocalError(
        "Choose a PDF within the 50 MB limit. Other file types are not supported yet.",
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
            ? "Course setup currently accepts only the matching course PDF."
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
            Choose a PDF. Reflo will validate it and build a source-backed
            course outline; lessons, quizzes, and audio may continue preparing
            afterward.
          </p>
        </div>
      </div>

      {approvalScreen === "loading" ? (
        <p className="upload-loading" role="status">
          Preparing PDF upload…
        </p>
      ) : null}
      {approvalScreen === "error" ? (
        <div className="upload-state tone-negative">
          <strong>PDF upload is temporarily unavailable</strong>
          <p>
            Reflo could not prepare the upload. Existing courses are unaffected.
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
          <strong>PDF upload is unavailable</strong>
          <p>No demo course has been configured yet.</p>
        </div>
      ) : null}
      {approvalScreen === "ready" && approvals.length > 0 ? (
        <>
          <form
            className="demo-upload-form"
            aria-busy={isBusy}
            onSubmit={submit}
          >
            <label htmlFor="demo-source-file">Course PDF</label>
            <input
              accept={DEMO_UPLOAD_FILE_ACCEPT}
              disabled={formLocked}
              id="demo-source-file"
              key={trackedUploadId ?? "new"}
              onChange={(event) =>
                setFile(event.currentTarget.files?.[0] ?? null)
              }
              required
              type="file"
            />
            <button disabled={formLocked} type="submit">
              {submissionScreen === "submitting"
                ? "Uploading…"
                : trackedUploadPending
                  ? "Loading upload status…"
                  : trackedUploadUnavailable
                    ? "Upload status unavailable"
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
            <div className="upload-local-error" role="alert">
              <p>{localError}</p>
              {trackedUploadUnavailable ? (
                <button
                  className="secondary-button"
                  onClick={() =>
                    setTrackedUploadReloadKey((current) => current + 1)
                  }
                  type="button"
                >
                  Retry loading upload status
                </button>
              ) : null}
            </div>
          )}
          {trackedUploadPending ? (
            <p aria-live="polite" className="upload-loading" role="status">
              Loading the selected course upload status…
            </p>
          ) : null}
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
