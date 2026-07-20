"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import Image from "next/image";
import Link from "next/link";

import type { LibraryCourse, SessionHistoryItem } from "@reflo/accounts";

import { courseProgress, sessionDuration } from "./account-view";

interface AccountShellProps {
  readonly apiOrigin: string;
  readonly appName: string;
  readonly environment: string;
}

type Screen = "loading" | "signed-out" | "email-sent" | "dashboard" | "error";

export function AccountShell({
  apiOrigin,
  appName,
  environment,
}: AccountShellProps) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [email, setEmail] = useState("");
  const [courses, setCourses] = useState<readonly LibraryCourse[]>([]);
  const [sessions, setSessions] = useState<readonly SessionHistoryItem[]>([]);

  const loadAccount = useCallback(async () => {
    try {
      const [libraryResponse, historyResponse] = await Promise.all([
        fetch(`${apiOrigin}/v1/library`, { credentials: "include" }),
        fetch(`${apiOrigin}/v1/session-history`, { credentials: "include" }),
      ]);
      if (libraryResponse.status === 401 || historyResponse.status === 401) {
        setScreen("signed-out");
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
      setCourses(library.courses);
      setSessions(history.sessions);
      setScreen("dashboard");
    } catch {
      setScreen("error");
    }
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccount(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAccount]);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`${apiOrigin}/v1/auth/magic-link`, {
      body: JSON.stringify({ email }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);
    setScreen(response?.ok ? "email-sent" : "error");
  }

  return (
    <section className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label={`${appName} home`}>
          <Image alt="" height={28} src="/reflo-mark.svg" width={28} />
          <span>{appName}</span>
        </Link>
        <span className="environment">{environment}</span>
      </header>

      {screen === "loading" ? <LoadingState /> : null}
      {screen === "signed-out" ? (
        <SignIn email={email} onEmail={setEmail} onSubmit={requestLink} />
      ) : null}
      {screen === "email-sent" ? <EmailSent email={email} /> : null}
      {screen === "error" ? (
        <ErrorState onRetry={() => void loadAccount()} />
      ) : null}
      {screen === "dashboard" ? (
        <Dashboard courses={courses} sessions={sessions} />
      ) : null}
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
  courses,
  sessions,
}: {
  readonly courses: readonly LibraryCourse[];
  readonly sessions: readonly SessionHistoryItem[];
}) {
  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Personal library</p>
          <h1>Good to have you back.</h1>
        </div>
        <button className="secondary-button" type="button">
          + Add material
        </button>
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
                  <article className="course-card" key={course.courseId}>
                    <div className={`course-art tone-${progress.tone}`}>
                      <span>{course.title.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="course-body">
                      <p className="course-kicker">Course</p>
                      <h3>{course.title}</h3>
                      <div className="progress-copy">
                        <span>{progress.label}</span>
                        <span>{progress.percent}%</span>
                      </div>
                      <div
                        className="progress-track"
                        aria-label={`${progress.percent}% ready`}
                      >
                        <span style={{ width: `${progress.percent}%` }} />
                      </div>
                    </div>
                  </article>
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
          {sessions.length === 0 ? (
            <EmptyState
              title="No study sessions"
              copy="Completed and paused sessions will appear here."
            />
          ) : (
            <ol className="history-list">
              {sessions.slice(0, 6).map((session) => (
                <li key={session.sessionId}>
                  <span className={`history-dot status-${session.status}`} />
                  <div>
                    <strong>{session.courseTitle}</strong>
                    <small>
                      {new Date(session.startedAt).toLocaleDateString()}
                    </small>
                  </div>
                  <span>{sessionDuration(session)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
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

function LoadingState() {
  return (
    <div className="center-state">
      <span className="loading-ring" />
      <p>Opening your library…</p>
    </div>
  );
}

function ErrorState({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="center-state">
      <p className="eyebrow">Connection paused</p>
      <h1>We couldn’t open your library.</h1>
      <p className="lede">Your progress is safe. Try the connection again.</p>
      <button onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}
