"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import Image from "next/image";
import Link from "next/link";

import type { EmailQuizPreview } from "@reflo/delivery";

interface EmailQuizProps {
  readonly apiOrigin: string;
  readonly appName: string;
  readonly environment: string;
}

type QuizScreen =
  | "authentication-required"
  | "error"
  | "invalid"
  | "loading"
  | "ready"
  | "submitted"
  | "submitting";

interface SubmissionResult {
  readonly attemptId: string;
  readonly correct: boolean;
  readonly status: "created" | "replayed";
  readonly streak: {
    readonly current: number;
    readonly longest: number;
  };
}

export function EmailQuiz({ apiOrigin, appName, environment }: EmailQuizProps) {
  const token = useRef<string | null>(null);
  const [screen, setScreen] = useState<QuizScreen>("loading");
  const [quiz, setQuiz] = useState<EmailQuizPreview | null>(null);
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [results, setResults] = useState<readonly SubmissionResult[]>([]);

  useEffect(() => {
    const linkToken = new URLSearchParams(window.location.search).get("token");
    token.current = linkToken;
    if (linkToken === null) {
      const timer = window.setTimeout(() => setScreen("invalid"), 0);
      return () => window.clearTimeout(timer);
    }
    window.history.replaceState(null, "", "/demo/review");
    const controller = new AbortController();
    void fetch(
      `${apiOrigin}/v1/demo/email-quiz?token=${encodeURIComponent(linkToken)}`,
      {
        credentials: "include",
        signal: controller.signal,
      },
    ).then(
      async (response) => {
        if (response.status === 401) {
          setScreen("authentication-required");
          return;
        }
        if (response.status === 404 || response.status === 410) {
          setScreen("invalid");
          return;
        }
        if (!response.ok) {
          setScreen("error");
          return;
        }
        const body = (await response.json()) as { quiz: EmailQuizPreview };
        if (
          !body.quiz.demoOnly ||
          body.quiz.questions.length < 1 ||
          body.quiz.questions.length > 3
        ) {
          setScreen("error");
          return;
        }
        setQuiz(body.quiz);
        setScreen("ready");
      },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setScreen("error");
        }
      },
    );
    return () => controller.abort();
  }, [apiOrigin]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      token.current === null ||
      quiz === null ||
      quiz.questions.some(
        (question) => answers[question.deliveryItemId] === undefined,
      )
    ) {
      return;
    }
    setScreen("submitting");
    try {
      const csrfResponse = await fetch(`${apiOrigin}/v1/csrf-token`, {
        credentials: "include",
      });
      if (csrfResponse.status === 401) {
        setScreen("authentication-required");
        return;
      }
      if (!csrfResponse.ok) {
        throw new Error("csrf_unavailable");
      }
      const { csrfToken } = (await csrfResponse.json()) as {
        readonly csrfToken: string;
      };
      const response = await fetch(`${apiOrigin}/v1/demo/email-quiz/submit`, {
        body: JSON.stringify({
          answers: quiz.questions.map((question) => ({
            answer: answers[question.deliveryItemId],
            deliveryItemId: question.deliveryItemId,
          })),
          token: token.current,
        }),
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-reflo-csrf": csrfToken,
        },
        method: "POST",
      });
      if (response.status === 401) {
        setScreen("authentication-required");
        return;
      }
      if (response.status === 404 || response.status === 410) {
        setScreen("invalid");
        return;
      }
      if (!response.ok) {
        throw new Error("submission_failed");
      }
      const body = (await response.json()) as {
        readonly results: readonly SubmissionResult[];
      };
      if (body.results.length !== quiz.questions.length) {
        throw new Error("invalid_submission_result");
      }
      setResults(body.results);
      setScreen("submitted");
    } catch {
      setScreen("error");
    }
  }

  return (
    <section className="app-shell quiz-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label={`${appName} home`}>
          <Image alt="" height={28} src="/reflo-mark.svg" width={28} />
          <span>{appName}</span>
        </Link>
        <span className="environment">{environment}</span>
      </header>

      <div className="quiz-layout">
        <div className="quiz-heading">
          <p className="eyebrow">Staff-controlled demo only</p>
          <h1>Your daily review.</h1>
          <p>
            Answer each question once. Confidently graded evidence updates the
            demo knowledge model and retention schedule.
          </p>
        </div>

        {screen === "loading" ? (
          <QuizStatus title="Opening your review…" />
        ) : null}
        {screen === "authentication-required" ? (
          <QuizStatus
            action="/"
            actionLabel="Sign in to the intended demo account"
            title="Authentication required"
          >
            This signed link is also bound to the staff test identity it was
            sent to.
          </QuizStatus>
        ) : null}
        {screen === "invalid" ? (
          <QuizStatus
            action="/"
            actionLabel="Return to Reflo"
            title="This review link is unavailable"
          >
            It may have expired, already been redeemed, or belong to a different
            demo identity.
          </QuizStatus>
        ) : null}
        {screen === "error" ? (
          <QuizStatus
            action="/demo/review"
            actionLabel="Try again"
            title="The review could not be loaded"
          >
            The delivery remains safe to retry; a retry cannot create duplicate
            attempts.
          </QuizStatus>
        ) : null}
        {(screen === "ready" || screen === "submitting") && quiz !== null ? (
          <form className="quiz-form" onSubmit={submit}>
            {quiz.questions.map((question, questionIndex) => (
              <fieldset className="quiz-question" key={question.deliveryItemId}>
                <legend>
                  <span>Question {questionIndex + 1}</span>
                  {question.prompt}
                </legend>
                <div className="quiz-options">
                  {question.responseOptions.map((option, optionIndex) => (
                    <label key={`${question.deliveryItemId}/${optionIndex}`}>
                      <input
                        checked={answers[question.deliveryItemId] === option}
                        name={question.deliveryItemId}
                        onChange={() =>
                          setAnswers((current) => ({
                            ...current,
                            [question.deliveryItemId]: option,
                          }))
                        }
                        type="radio"
                        value={option}
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <button
              disabled={
                screen === "submitting" ||
                quiz.questions.some(
                  (question) => answers[question.deliveryItemId] === undefined,
                )
              }
              type="submit"
            >
              {screen === "submitting" ? "Recording…" : "Submit review"}
            </button>
            <small>
              This link expires at {new Date(quiz.expiresAt).toLocaleString()}.
            </small>
          </form>
        ) : null}
        {screen === "submitted" ? (
          <SubmissionSummary results={results} />
        ) : null}
      </div>
    </section>
  );
}

function QuizStatus({
  action,
  actionLabel,
  children,
  title,
}: {
  readonly action?: string;
  readonly actionLabel?: string;
  readonly children?: React.ReactNode;
  readonly title: string;
}) {
  return (
    <section className="quiz-card quiz-status" aria-live="polite">
      <h2>{title}</h2>
      {children === undefined ? null : <p>{children}</p>}
      {action === undefined || actionLabel === undefined ? (
        <span className="loading-ring" />
      ) : (
        <Link className="button-link" href={action}>
          {actionLabel}
        </Link>
      )}
    </section>
  );
}

function SubmissionSummary({
  results,
}: {
  readonly results: readonly SubmissionResult[];
}) {
  const correct = results.filter((result) => result.correct).length;
  const streak = results.at(-1)?.streak;
  return (
    <section className="quiz-card quiz-result" aria-live="polite">
      <p className="eyebrow">Review recorded</p>
      <h2>
        {correct} of {results.length} correct
      </h2>
      <p>
        {streak === undefined
          ? "Your demo knowledge state is up to date."
          : `${streak.current}-day current streak · ${streak.longest}-day best`}
      </p>
      <Link className="button-link" href="/">
        View the Knowledge Map
      </Link>
    </section>
  );
}
