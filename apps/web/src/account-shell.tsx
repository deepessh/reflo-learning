"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import Image from "next/image";
import Link from "next/link";

import type {
  CourseProgress,
  LibraryCourse,
  SessionHistoryItem,
} from "@reflo/accounts";

import {
  courseStudyAvailability,
  courseProgress,
  sessionDuration,
  sessionSummaryPresentation,
} from "./account-view";
import {
  accountConnectionStatus,
  activateControlFromKeyboard,
  retryPresentation,
  type AccountRequestKind,
  type RetryState,
} from "./account-shell-accessibility";
import {
  browserApiOrigin,
  browserCanonicalPageUrl,
} from "./browser-api-origin";
import {
  browserCourseId,
  courseIdToRestore,
  pushBrowserCourse,
  replaceBrowserCourse,
} from "./course-selection-navigation";
import { DemoUploadPanel } from "./demo-upload-panel";
import { DeliveryPreferences } from "./delivery-preferences";
import { FlowBStudy } from "./flow-b-study";
import { KnowledgeMap } from "./knowledge-map";

interface AccountShellProps {
  readonly apiOrigin: string;
  readonly appName: string;
}

type Screen = "loading" | "signed-out" | "email-sent" | "dashboard" | "error";
type ProgressScreen = "idle" | "loading" | "ready" | "error";

function activateLinkFromKeyboard(event: KeyboardEvent<HTMLAnchorElement>) {
  activateControlFromKeyboard(event);
}

function activateDashboardControlFromKeyboard(
  event: KeyboardEvent<HTMLDivElement>,
) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches("button, summary")) {
    return;
  }
  activateControlFromKeyboard({
    currentTarget: target,
    key: event.key,
    preventDefault: () => event.preventDefault(),
    repeat: event.repeat,
  });
}

export function AccountShell({ apiOrigin, appName }: AccountShellProps) {
  const resolvedApiOrigin = browserApiOrigin(apiOrigin);
  const canonicalPageUrl = browserCanonicalPageUrl(apiOrigin);
  const [screen, setScreen] = useState<Screen>("loading");
  const [email, setEmail] = useState("");
  const [courses, setCourses] = useState<readonly LibraryCourse[]>([]);
  const [sessions, setSessions] = useState<readonly SessionHistoryItem[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [progressScreen, setProgressScreen] = useState<ProgressScreen>("idle");
  const [retryState, setRetryState] = useState<RetryState>("idle");
  const [accountStatusMessage, setAccountStatusMessage] = useState(
    accountConnectionStatus("initial", "pending"),
  );
  const accountRequestId = useRef(0);
  const progressRequestId = useRef(0);
  const retryPending = useRef(false);

  const loadProgress = useCallback(
    async (courseId: string) => {
      const requestId = ++progressRequestId.current;
      setProgressScreen("loading");
      setProgress(null);
      try {
        const response = await fetch(
          `${resolvedApiOrigin}/v1/courses/${encodeURIComponent(courseId)}/progress`,
          { credentials: "include" },
        );
        if (requestId !== progressRequestId.current) {
          return;
        }
        if (response.status === 401) {
          setScreen("signed-out");
          setProgressScreen("idle");
          return;
        }
        if (!response.ok) {
          throw new Error("course_progress_unavailable");
        }
        const body = (await response.json()) as { progress: CourseProgress };
        if (requestId !== progressRequestId.current) {
          return;
        }
        setProgress(body.progress);
        setProgressScreen("ready");
      } catch {
        if (requestId === progressRequestId.current) {
          setProgressScreen("error");
        }
      }
    },
    [resolvedApiOrigin],
  );

  const loadAccount = useCallback(
    async (
      preferredCourseId?: string,
      requestKind: AccountRequestKind = "refresh",
    ) => {
      const requestId = ++accountRequestId.current;
      try {
        const [libraryResponse, historyResponse] = await Promise.all([
          fetch(`${resolvedApiOrigin}/v1/library`, {
            credentials: "include",
          }),
          fetch(`${resolvedApiOrigin}/v1/session-history`, {
            credentials: "include",
          }),
        ]);
        if (requestId !== accountRequestId.current) {
          return;
        }
        if (libraryResponse.status === 401 || historyResponse.status === 401) {
          setScreen("signed-out");
          setRetryState("idle");
          setAccountStatusMessage(
            accountConnectionStatus(requestKind, "signed-out"),
          );
          return;
        }
        if (!libraryResponse.ok || !historyResponse.ok) {
          throw new Error("account_surface_unavailable");
        }
        const library = (await libraryResponse.json()) as {
          courses: readonly LibraryCourse[];
        };
        const history = (await historyResponse.json()) as {
          sessions: readonly SessionHistoryItem[];
        };
        if (requestId !== accountRequestId.current) {
          return;
        }
        setCourses(library.courses);
        setSessions(history.sessions);
        const initialCourseId = courseIdToRestore(
          library.courses.map((course) => course.courseId),
          preferredCourseId,
        );
        const initialCourse = library.courses.find(
          (course) => course.courseId === initialCourseId,
        );
        replaceBrowserCourse(initialCourse?.courseId ?? null);
        setSelectedCourseId(initialCourse?.courseId ?? null);
        if (initialCourse === undefined) {
          progressRequestId.current += 1;
          setProgress(null);
          setProgressScreen("idle");
        } else {
          void loadProgress(initialCourse.courseId);
        }
        setScreen("dashboard");
        setRetryState("idle");
        setAccountStatusMessage(
          accountConnectionStatus(requestKind, "success"),
        );
      } catch {
        if (requestId === accountRequestId.current) {
          setScreen("error");
          setRetryState(requestKind === "retry" ? "failed" : "idle");
          setAccountStatusMessage(
            accountConnectionStatus(requestKind, "failure"),
          );
        }
      }
    },
    [loadProgress, resolvedApiOrigin],
  );

  useEffect(() => {
    if (canonicalPageUrl !== null) {
      window.location.replace(canonicalPageUrl);
      return;
    }
    const timer = window.setTimeout(
      () => void loadAccount(browserCourseId() ?? undefined, "initial"),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [canonicalPageUrl, loadAccount]);

  useEffect(() => {
    function restoreBrowserCourse() {
      void loadAccount(browserCourseId() ?? undefined, "refresh");
    }
    window.addEventListener("popstate", restoreBrowserCourse);
    return () => window.removeEventListener("popstate", restoreBrowserCourse);
  }, [loadAccount]);

  async function retryAccount() {
    if (retryPending.current) {
      return;
    }
    retryPending.current = true;
    setRetryState("pending");
    setAccountStatusMessage(accountConnectionStatus("retry", "pending"));
    try {
      await loadAccount(browserCourseId() ?? undefined, "retry");
    } finally {
      retryPending.current = false;
    }
  }

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`${resolvedApiOrigin}/v1/auth/magic-link`, {
      body: JSON.stringify({ email }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);
    setScreen(response?.ok ? "email-sent" : "error");
  }

  return (
    <section className="app-shell">
      <p
        className="visually-hidden"
        role="status"
        aria-atomic="true"
        aria-live="polite"
      >
        {accountStatusMessage}
      </p>
      <a
        className="skip-link"
        href="#main-content"
        onClick={() => {
          window.setTimeout(() => {
            document.getElementById("main-content")?.focus();
          }, 0);
        }}
        onKeyDown={activateLinkFromKeyboard}
      >
        Skip to learning dashboard
      </a>
      <nav className="topbar" aria-label="Primary">
        <Link
          className="brand"
          href="/"
          aria-label={`${appName} home`}
          onKeyDown={activateLinkFromKeyboard}
        >
          <Image alt="" height={28} src="/reflo-mark.svg" width={28} />
          <span>{appName}</span>
        </Link>
        <span className="topbar-purpose">Learn · review · retain</span>
      </nav>

      <div id="main-content" tabIndex={-1}>
        {screen === "loading" ? <LoadingState /> : null}
        {screen === "signed-out" ? (
          <SignIn email={email} onEmail={setEmail} onSubmit={requestLink} />
        ) : null}
        {screen === "email-sent" ? <EmailSent email={email} /> : null}
        {screen === "error" ? (
          <ErrorState
            onRetry={() => void retryAccount()}
            retryState={retryState}
          />
        ) : null}
        {screen === "dashboard" ? (
          <Dashboard
            apiOrigin={resolvedApiOrigin}
            courses={courses}
            onArchiveCourse={async () => {
              await loadAccount(undefined, "refresh");
            }}
            onRetryProgress={() => {
              if (selectedCourseId !== null) {
                void loadProgress(selectedCourseId);
              }
            }}
            onSelectCourse={(courseId) => {
              accountRequestId.current += 1;
              pushBrowserCourse(courseId);
              setSelectedCourseId(courseId);
              void loadProgress(courseId);
            }}
            onUploadedCourse={(courseId) => {
              pushBrowserCourse(courseId);
              void loadAccount(courseId);
            }}
            progress={progress}
            progressScreen={progressScreen}
            selectedCourseId={selectedCourseId}
            sessions={sessions}
          />
        ) : null}
      </div>
    </section>
  );
}

function SignIn({
  email,
  onEmail,
  onSubmit,
}: {
  readonly email: string;
  readonly onEmail: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="auth-layout">
      <div className="auth-copy">
        <p className="eyebrow">Your learning, remembered</p>
        <h1>Pick up exactly where you left off.</h1>
        <p className="lede">
          Your library, study history, and concept progress stay connected
          across every session.
        </p>
      </div>
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="step">Secure email access</span>
        <h2>Sign in to Reflo</h2>
        <p>
          No password to remember. We’ll email a link that expires in 10
          minutes.
        </p>
        <label htmlFor="email">Email address</label>
        <input
          autoComplete="email"
          id="email"
          name="email"
          onChange={(event) => onEmail(event.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
        <button type="submit">Email me a secure link</button>
        <small>
          The response is identical whether or not an account already exists.
        </small>
      </form>
    </div>
  );
}

function EmailSent({ email }: { readonly email: string }) {
  return (
    <div className="center-state">
      <span className="state-icon">↗</span>
      <p className="eyebrow">Check your inbox</p>
      <h1>Your secure link is on its way.</h1>
      <p className="lede">
        If <strong>{email}</strong> can receive Reflo mail, the link will arrive
        shortly. It works once and expires in 10 minutes.
      </p>
    </div>
  );
}

function Dashboard({
  apiOrigin,
  courses,
  onArchiveCourse,
  onRetryProgress,
  onSelectCourse,
  onUploadedCourse,
  progress,
  progressScreen,
  selectedCourseId,
  sessions,
}: {
  readonly apiOrigin: string;
  readonly courses: readonly LibraryCourse[];
  readonly onArchiveCourse: (courseId: string) => Promise<void>;
  readonly onRetryProgress: () => void;
  readonly onSelectCourse: (courseId: string) => void;
  readonly onUploadedCourse: (courseId: string) => void;
  readonly progress: CourseProgress | null;
  readonly progressScreen: ProgressScreen;
  readonly selectedCourseId: string | null;
  readonly sessions: readonly SessionHistoryItem[];
}) {
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<
    string | null
  >(null);
  const [archivePendingCourseId, setArchivePendingCourseId] = useState<
    string | null
  >(null);
  const [archiveStatusMessage, setArchiveStatusMessage] = useState("");
  const visibleSessions = sessions.filter((session) =>
    courses.some((course) => course.courseId === session.courseId),
  );
  const selectedHistorySession =
    visibleSessions.find(
      (session) => session.sessionId === selectedHistorySessionId,
    ) ?? null;
  const selectedCourse =
    courses.find((course) => course.courseId === selectedCourseId) ?? null;
  const studyAvailability =
    selectedCourse === null ? null : courseStudyAvailability(selectedCourse);
  const courseSetupDisclosure = useRef<HTMLDetailsElement>(null);

  function scrollToStudy() {
    window.setTimeout(() => {
      document
        .getElementById("study-session")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function openHistorySession(session: SessionHistoryItem) {
    onSelectCourse(session.courseId);
    if (session.status === "active") {
      setSelectedHistorySessionId(null);
      scrollToStudy();
      return;
    }
    setSelectedHistorySessionId((selected) =>
      selected === session.sessionId ? null : session.sessionId,
    );
  }

  function openCourseSetup() {
    const disclosure = courseSetupDisclosure.current;
    if (disclosure === null) {
      return;
    }
    disclosure.open = true;
    window.setTimeout(() => {
      disclosure.querySelector<HTMLElement>("summary")?.focus();
      disclosure.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function archiveCourse(course: LibraryCourse) {
    if (archivePendingCourseId !== null) {
      return;
    }
    const label =
      course.courseStatus === "failed" || course.sourceStatus === "failed"
        ? "failed upload attempt"
        : "course";
    setArchivePendingCourseId(course.courseId);
    setArchiveStatusMessage(`Archiving ${label} ${course.title}.`);
    try {
      const csrfResponse = await fetch(`${apiOrigin}/v1/csrf-token`, {
        credentials: "include",
      });
      if (!csrfResponse.ok) {
        throw new Error("csrf_unavailable");
      }
      const { csrfToken } = (await csrfResponse.json()) as {
        readonly csrfToken: string;
      };
      const response = await fetch(
        `${apiOrigin}/v1/courses/${encodeURIComponent(course.courseId)}/archive`,
        {
          credentials: "include",
          headers: { "x-reflo-csrf": csrfToken },
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error("archive_failed");
      }
      await onArchiveCourse(course.courseId);
      setArchiveStatusMessage(`${course.title} was archived.`);
      window.setTimeout(() => {
        document
          .querySelector<HTMLButtonElement>('.course-card[aria-pressed="true"]')
          ?.focus();
      }, 0);
    } catch {
      setArchiveStatusMessage(`Could not archive ${course.title}. Try again.`);
    } finally {
      setArchivePendingCourseId(null);
    }
  }

  return (
    <div className="dashboard" onKeyDown={activateDashboardControlFromKeyboard}>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {archiveStatusMessage}
      </p>
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Personal library</p>
          <h1>Good to have you back.</h1>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="panel course-panel">
          <div className="panel-heading">
            <h2>Your courses</h2>
            <span>{courses.length}</span>
          </div>
          {courses.length === 0 ? (
            <EmptyState
              title="No courses yet"
              copy="Upload a supported study guide to build your first course."
            />
          ) : (
            <div className="course-grid">
              {courses.map((course) => {
                const progress = courseProgress(course);
                return (
                  <button
                    aria-pressed={selectedCourseId === course.courseId}
                    className={`course-card ${
                      selectedCourseId === course.courseId ? "is-selected" : ""
                    }`}
                    key={course.courseId}
                    onClick={() => onSelectCourse(course.courseId)}
                    type="button"
                  >
                    <div className={`course-art tone-${progress.tone}`}>
                      <span>{course.title.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="course-body">
                      <p className="course-kicker">Course</p>
                      <h3>{course.title}</h3>
                      <div className="progress-copy">
                        <span>{progress.label}</span>
                        <span>
                          {progress.percent === null
                            ? "In progress"
                            : `${progress.percent}%`}
                        </span>
                      </div>
                      <div
                        className="progress-track"
                        aria-label={
                          progress.percent === null
                            ? `${progress.label}; completion is still being calculated`
                            : `${progress.percent}% ready`
                        }
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={progress.percent ?? undefined}
                        role="progressbar"
                      >
                        <span
                          className={
                            progress.percent === null ? "is-indeterminate" : ""
                          }
                          style={
                            progress.percent === null
                              ? undefined
                              : { width: `${progress.percent}%` }
                          }
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel history-panel">
          <div className="panel-heading">
            <h2>Recent sessions</h2>
            <span>Latest</span>
          </div>
          {visibleSessions.length === 0 ? (
            <EmptyState
              title="No study sessions"
              copy="Completed and paused sessions will appear here."
            />
          ) : (
            <ol className="history-list">
              {visibleSessions.slice(0, 6).map((session) => (
                <li key={session.sessionId}>
                  <span className={`history-dot status-${session.status}`} />
                  <button
                    aria-controls={
                      session.status === "active"
                        ? "study-session"
                        : `history-summary-${session.sessionId}`
                    }
                    aria-expanded={
                      session.status === "active"
                        ? undefined
                        : selectedHistorySessionId === session.sessionId
                    }
                    className="history-action"
                    onClick={() => openHistorySession(session)}
                    type="button"
                  >
                    <span>
                      <strong>{session.courseTitle}</strong>
                      <small>
                        {new Date(session.startedAt).toLocaleDateString()}
                      </small>
                    </span>
                    <small>
                      {session.status === "active"
                        ? "Continue"
                        : selectedHistorySessionId === session.sessionId
                          ? "Hide summary"
                          : "View summary"}
                    </small>
                  </button>
                  <span>{sessionDuration(session)}</span>
                </li>
              ))}
            </ol>
          )}
          {selectedHistorySession !== null ? (
            <SessionHistorySummary
              onReturnToCourse={() => {
                onSelectCourse(selectedHistorySession.courseId);
                scrollToStudy();
              }}
              session={selectedHistorySession}
            />
          ) : null}
        </section>
      </div>

      {selectedCourseId !== null && studyAvailability?.kind === "available" ? (
        <FlowBStudy
          apiOrigin={apiOrigin}
          courseId={selectedCourseId}
          key={`${selectedCourseId}:${
            visibleSessions.find(
              (session) =>
                session.courseId === selectedCourseId &&
                session.status === "active",
            )?.sessionId ?? "new"
          }`}
          onProgressRefresh={onRetryProgress}
          resumeSessionId={
            visibleSessions.find(
              (session) =>
                session.courseId === selectedCourseId &&
                session.status === "active",
            )?.sessionId ?? null
          }
        />
      ) : null}
      {selectedCourse !== null &&
      studyAvailability !== null &&
      studyAvailability.kind !== "available" ? (
        <CourseStudyUnavailable
          availability={studyAvailability}
          canDismiss={
            selectedCourse.courseStatus === "failed" ||
            selectedCourse.sourceStatus === "failed"
          }
          dismissPending={archivePendingCourseId === selectedCourse.courseId}
          onDismiss={() => void archiveCourse(selectedCourse)}
          onReviewCourseSetup={openCourseSetup}
        />
      ) : null}

      {selectedCourseId !== null && progressScreen === "loading" ? (
        <section className="panel progress-state">
          <span className="loading-ring" />
          <div>
            <strong>Loading your progress…</strong>
            <p>Bringing your latest mastery and review schedule into view.</p>
          </div>
        </section>
      ) : null}
      {selectedCourseId !== null && progressScreen === "error" ? (
        <section className="panel progress-state">
          <div>
            <strong>Knowledge Map is temporarily unavailable.</strong>
            <p>Your stored evidence is unchanged.</p>
          </div>
          <button onClick={onRetryProgress} type="button">
            Try again
          </button>
        </section>
      ) : null}
      {progressScreen === "ready" && progress !== null ? (
        <KnowledgeMap
          archivePending={archivePendingCourseId === progress.courseId}
          key={progress.courseId}
          onArchive={() => {
            if (selectedCourse !== null) {
              void archiveCourse(selectedCourse);
            }
          }}
          onRefresh={onRetryProgress}
          progress={progress}
        />
      ) : null}

      <div className="dashboard-settings">
        <details className="preference-disclosure">
          <summary>Review reminders</summary>
          <p>Choose when and where Reflo sends your next review.</p>
          <DeliveryPreferences apiOrigin={apiOrigin} />
        </details>
        <details
          className="import-disclosure"
          id="course-setup-disclosure"
          ref={courseSetupDisclosure}
        >
          <summary>Add course material</summary>
          <p>
            Choose a PDF and Reflo will build a source-backed course outline
            before lessons become available.
          </p>
          <DemoUploadPanel
            apiOrigin={apiOrigin}
            onCourseReady={onUploadedCourse}
            trackedUploadId={
              selectedCourse !== null &&
              (selectedCourse.courseStatus === "generating" ||
                selectedCourse.courseStatus === "failed" ||
                selectedCourse.sourceStatus === "failed")
                ? selectedCourse.sourceDocumentId
                : null
            }
          />
        </details>
      </div>
    </div>
  );
}

function CourseStudyUnavailable({
  availability,
  canDismiss,
  dismissPending,
  onDismiss,
  onReviewCourseSetup,
}: {
  readonly availability: Exclude<
    ReturnType<typeof courseStudyAvailability>,
    { readonly kind: "available" }
  >;
  readonly canDismiss: boolean;
  readonly dismissPending: boolean;
  readonly onDismiss: () => void;
  readonly onReviewCourseSetup: () => void;
}) {
  return (
    <section
      className="panel flow-panel"
      id="study-session"
      aria-labelledby="study-unavailable-title"
      tabIndex={-1}
    >
      <p className="eyebrow">Today’s session</p>
      <h2 id="study-unavailable-title">Study is not available</h2>
      <div
        className="flow-notice"
        role={availability.kind === "preparing" ? "status" : "alert"}
      >
        <strong>{availability.title}</strong>
        <p>{availability.copy}</p>
        <div className="flow-notice-actions">
          <button
            aria-controls="course-setup-disclosure"
            onClick={onReviewCourseSetup}
            type="button"
          >
            Review upload options
          </button>
          {canDismiss ? (
            <button disabled={dismissPending} onClick={onDismiss} type="button">
              {dismissPending ? "Dismissing…" : "Dismiss failed attempt"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function EmptyState({
  title,
  copy,
}: {
  readonly title: string;
  readonly copy: string;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function SessionHistorySummary({
  onReturnToCourse,
  session,
}: {
  readonly onReturnToCourse: () => void;
  readonly session: SessionHistoryItem;
}) {
  const summary = sessionSummaryPresentation(session);
  return (
    <aside
      className="history-summary"
      id={`history-summary-${session.sessionId}`}
      aria-label={`${session.courseTitle} session summary`}
    >
      <div className="history-summary-heading">
        <div>
          <span>{summary.statusLabel}</span>
          <strong>{session.courseTitle}</strong>
        </div>
        <span>{sessionDuration(session)}</span>
      </div>
      <p>{summary.detail}</p>
      <small>
        Started {new Date(session.startedAt).toLocaleString()}
        {session.endedAt === null
          ? ""
          : ` · Finished ${new Date(session.endedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}`}
      </small>
      <button
        className="secondary-button"
        onClick={onReturnToCourse}
        type="button"
      >
        Study this course again
      </button>
    </aside>
  );
}

function LoadingState() {
  return (
    <div className="center-state">
      <span className="loading-ring" />
      <p>Opening your library…</p>
    </div>
  );
}

export function ErrorState({
  onRetry,
  retryState,
}: {
  readonly onRetry: () => void;
  readonly retryState: RetryState;
}) {
  const presentation = retryPresentation(retryState);
  const retryButton = useRef<HTMLButtonElement>(null);
  const previousRetryState = useRef(retryState);

  useEffect(() => {
    if (previousRetryState.current === "pending" && retryState !== "pending") {
      retryButton.current?.focus();
    }
    previousRetryState.current = retryState;
  }, [retryState]);

  return (
    <div className="center-state" aria-busy={presentation.ariaBusy}>
      <p className="eyebrow">Connection paused</p>
      <h1>We couldn’t open your library.</h1>
      <p className="lede">Your progress is safe. Try the connection again.</p>
      {presentation.visibleStatus === null ? null : (
        <p>{presentation.visibleStatus}</p>
      )}
      <button
        disabled={presentation.buttonDisabled}
        onClick={onRetry}
        onKeyDown={activateControlFromKeyboard}
        ref={retryButton}
        type="button"
      >
        {presentation.buttonLabel}
      </button>
    </div>
  );
}
