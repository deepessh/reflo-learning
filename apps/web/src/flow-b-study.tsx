"use client";

import { useState, type FormEvent } from "react";

import type {
  ConnectedDemoPreflightDependency,
  ConnectedDemoPreflightView,
  ConnectedStudyQuestion,
  ConnectedStudyView,
} from "@reflo/contracts";

import {
  assessmentDisposition,
  unavailableDependencyNames,
  type BrowserAssessmentResult,
} from "./flow-b-view";
import { exactPercentLabel, masteryDeltaLabel } from "./account-view";

type Phase =
  | "blocked"
  | "checking"
  | "error"
  | "idle"
  | "lesson"
  | "question"
  | "resetting"
  | "result"
  | "submitting"
  | "summary";
type QuestionStage = "initial" | "retest";

interface TutorAnswer {
  readonly citations?: readonly {
    readonly sectionPath: readonly string[];
  }[];
  readonly content?: string;
  readonly kind: "answer" | "not_found";
}

export function FlowBStudy({
  apiOrigin,
  courseId,
  onProgressRefresh,
  resumeSessionId,
}: {
  readonly apiOrigin: string;
  readonly courseId: string;
  readonly onProgressRefresh: () => void;
  readonly resumeSessionId: string | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [view, setView] = useState<ConnectedStudyView | null>(null);
  const [question, setQuestion] = useState<ConnectedStudyQuestion | null>(null);
  const [questionStage, setQuestionStage] = useState<QuestionStage>("initial");
  const [initialQuestionId, setInitialQuestionId] = useState<string | null>(
    null,
  );
  const [answer, setAnswer] = useState("");
  const [assessment, setAssessment] = useState<BrowserAssessmentResult | null>(
    null,
  );
  const [fallbackAnswer, setFallbackAnswer] = useState("");
  const [unavailable, setUnavailable] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [tutorQuestion, setTutorQuestion] = useState("");
  const [tutorAnswer, setTutorAnswer] = useState<TutorAnswer | null>(null);
  const [askingTutor, setAskingTutor] = useState(false);

  async function start(reset: boolean) {
    setPhase("checking");
    setMessage("");
    try {
      const preflight = await requestPreflight(apiOrigin);
      const missing = unavailableDependencyNames(preflight.dependencies);
      if (preflight.status !== "ready") {
        setUnavailable(missing);
        setPhase("blocked");
        return;
      }
      setUnavailable([]);
      if (reset) {
        setPhase("resetting");
        const seeded = await postJson<{
          seed: { readonly courseId: string; readonly sessionId: string };
        }>(apiOrigin, "/v1/demo/seed/reset");
        if (seeded.seed.courseId !== courseId) {
          throw new Error(
            "The connected demo seed does not match this course.",
          );
        }
        await loadView(seeded.seed.sessionId);
      } else if (resumeSessionId !== null) {
        await loadView(resumeSessionId);
      } else {
        throw new Error("No persisted demo session is available to resume.");
      }
    } catch (error) {
      fail(error, "The connected study session could not be opened.");
    }
  }

  async function loadView(sessionId: string) {
    const loaded = await requestJson<{ view: ConnectedStudyView }>(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/state`,
    );
    setView(loaded.view);
    if (loaded.view.state === "lesson_unavailable") {
      throw new Error(
        "The replacement lesson exists, but its authorized content is unavailable.",
      );
    }
    if (
      loaded.view.state === "complete" ||
      loaded.view.state === "review_scheduled"
    ) {
      setPhase("summary");
      onProgressRefresh();
      return;
    }
    if (loaded.view.state === "retest" && loaded.view.lesson !== null) {
      setPhase("lesson");
      return;
    }
    if (loaded.view.question === null) {
      throw new Error("No source-backed short-answer question is available.");
    }
    showQuestion(loaded.view.question, "initial");
  }

  function showQuestion(
    nextQuestion: ConnectedStudyQuestion,
    stage: QuestionStage,
  ) {
    if (stage === "retest" && nextQuestion.itemId === initialQuestionId) {
      fail(
        new Error("The re-test repeated the original question."),
        "A distinct re-test is unavailable.",
      );
      return;
    }
    setQuestion(nextQuestion);
    setQuestionStage(stage);
    if (stage === "initial") {
      setInitialQuestionId(nextQuestion.itemId);
    }
    setAnswer("");
    setAssessment(null);
    setFallbackAnswer("");
    setPhase("question");
  }

  async function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view === null || question === null || answer.trim() === "") {
      return;
    }
    setPhase("submitting");
    try {
      const idempotencyKey = await stableKey(
        "short-answer",
        view.sessionId,
        question.itemId,
        answer,
      );
      const response = await postJson<{ result: BrowserAssessmentResult }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(view.sessionId)}/answers/short-answer`,
        {
          answer,
          idempotencyKey,
          questionId: question.itemId,
        },
      );
      setAssessment(response.result);
      setPhase("result");
    } catch (error) {
      fail(error, "The answer was not confirmed. Retrying is replay-safe.");
    }
  }

  async function submitFallback() {
    const bundle = assessment?.fallback;
    const item = bundle?.items[0];
    if (
      view === null ||
      bundle === null ||
      bundle === undefined ||
      item === undefined ||
      fallbackAnswer === ""
    ) {
      return;
    }
    setPhase("submitting");
    try {
      const idempotencyKey = await stableKey(
        "replacement",
        view.sessionId,
        item.id,
        fallbackAnswer,
      );
      const response = await postJson<{ result: BrowserAssessmentResult }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(view.sessionId)}/answers/replacement`,
        {
          answer: fallbackAnswer,
          bundleId: bundle.id,
          idempotencyKey,
          itemId: item.id,
        },
      );
      setAssessment(response.result);
      setPhase("result");
    } catch (error) {
      fail(
        error,
        "The replacement answer was not confirmed. Retrying is replay-safe.",
      );
    }
  }

  async function nextAction() {
    if (view === null) {
      return;
    }
    setPhase("checking");
    try {
      const response = await postJson<{
        action:
          | {
              readonly kind: "reteach";
            }
          | {
              readonly kind: "retest";
              readonly question: ConnectedStudyQuestion;
            }
          | {
              readonly kind: "retest_succeeded";
            }
          | {
              readonly kind: "review_scheduled";
              readonly nextDeliveryAt: string;
            }
          | {
              readonly kind: "advance" | "review" | "session_complete";
            };
      }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(view.sessionId)}/next`,
      );
      if (response.action.kind === "reteach") {
        await loadView(view.sessionId);
        return;
      }
      if (response.action.kind === "retest") {
        showQuestion(response.action.question, "retest");
        return;
      }
      if (
        response.action.kind === "retest_succeeded" ||
        response.action.kind === "review_scheduled" ||
        response.action.kind === "session_complete"
      ) {
        await loadView(view.sessionId);
        setPhase("summary");
        onProgressRefresh();
        return;
      }
      throw new Error(
        "The Tutor Agent selected an action outside the seeded Flow B plan.",
      );
    } catch (error) {
      fail(error, "The Tutor Agent could not confirm the next action.");
    }
  }

  async function askTutor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view === null || tutorQuestion.trim() === "") {
      return;
    }
    setAskingTutor(true);
    setTutorAnswer(null);
    try {
      const idempotencyKey = await stableKey(
        "tutor-question",
        view.sessionId,
        view.courseId,
        tutorQuestion,
      );
      const response = await postJson<{ answer: TutorAnswer }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(view.sessionId)}/ask`,
        {
          courseId: view.courseId,
          idempotencyKey,
          question: tutorQuestion,
          sourceDocumentId: view.sourceDocumentId,
        },
      );
      setTutorAnswer(response.answer);
    } catch {
      setTutorAnswer({ kind: "not_found" });
    } finally {
      setAskingTutor(false);
    }
  }

  const disposition =
    assessment === null ? null : assessmentDisposition(assessment);
  const fallback = assessment?.fallback?.items[0] ?? null;

  return (
    <section className="panel flow-panel" aria-labelledby="flow-b-title">
      <div className="flow-heading">
        <div>
          <p className="eyebrow">Connected demo · seeded test identity</p>
          <h2 id="flow-b-title">Adaptive study loop</h2>
          <p>
            Stored evidence drives each step. Viewing a lesson or receiving an
            abstention never raises mastery.
          </p>
        </div>
        <span className="demo-badge">Demo only</span>
      </div>

      {phase === "idle" ? (
        <div className="flow-start">
          <div>
            <strong>Prove the full Flow B loop</strong>
            <p>
              Submit a failure, receive a materially different lesson, pass a
              distinct re-test, then refresh the persisted Knowledge Map.
            </p>
          </div>
          <div className="flow-actions">
            {resumeSessionId !== null ? (
              <button
                className="secondary-button"
                onClick={() => void start(false)}
                type="button"
              >
                Resume stored session
              </button>
            ) : null}
            <button onClick={() => void start(true)} type="button">
              Reset &amp; start demo
            </button>
          </div>
        </div>
      ) : null}

      {phase === "checking" || phase === "resetting" ? (
        <FlowBusy
          copy={
            phase === "checking"
              ? "Checking connected dependencies and persisted state…"
              : "Resetting the approved synthetic weak-concept fixture…"
          }
        />
      ) : null}

      {phase === "blocked" ? (
        <FlowNotice
          title="A required dependency is unavailable."
          copy={`No success was recorded. Check ${unavailable.join(", ") || "the connected runtime"}, then retry.`}
          onRetry={() => void start(view === null)}
        />
      ) : null}

      {phase === "error" ? (
        <FlowNotice
          title="The loop paused safely."
          copy={message}
          onRetry={() => {
            if (view === null) {
              setPhase("idle");
            } else {
              void loadView(view.sessionId).catch((error: unknown) =>
                fail(error, "The persisted study state remains unavailable."),
              );
            }
          }}
        />
      ) : null}

      {phase === "question" && view !== null && question !== null ? (
        <form className="flow-question" onSubmit={submitAnswer}>
          <FlowPlan view={view} />
          <p className="question-stage">
            {questionStage === "initial"
              ? "Evidence check · answer incompletely to demonstrate the trigger"
              : "Distinct re-test · answer from the new explanation"}
          </p>
          <h3>{question.prompt}</h3>
          <label htmlFor="flow-answer">Your answer</label>
          <textarea
            id="flow-answer"
            onChange={(event) => setAnswer(event.target.value)}
            required
            rows={4}
            value={answer}
          />
          <button type="submit">
            {questionStage === "initial" ? "Submit evidence" : "Submit re-test"}
          </button>
        </form>
      ) : null}

      {phase === "submitting" ? (
        <FlowBusy copy="Persisting and grading this exact submission…" />
      ) : null}

      {phase === "result" && assessment !== null ? (
        <div className="flow-result">
          <span className={`evidence-pill evidence-${disposition}`}>
            {disposition === "abstained"
              ? "Abstained · no mastery change"
              : disposition === "correct"
                ? "Eligible correct evidence"
                : disposition === "failed"
                  ? "Eligible failing evidence"
                  : "No eligible evidence"}
          </span>
          <h3>{assessment.learnerMessage}</h3>
          <p>
            {assessment.status === "replayed"
              ? "The server replayed the original result without creating another attempt."
              : "The server created one persisted attempt."}
          </p>
          {disposition === "abstained" && fallback !== null ? (
            <div className="fallback-card">
              <strong>Source-backed multiple-choice replacement</strong>
              <p>{fallback.question.prompt}</p>
              {fallback.question.responseOptions.map((option) => (
                <label className="choice-row" key={option}>
                  <input
                    checked={fallbackAnswer === option}
                    name="fallback"
                    onChange={() => setFallbackAnswer(option)}
                    type="radio"
                  />
                  <span>{option}</span>
                </label>
              ))}
              <button
                disabled={fallbackAnswer === ""}
                onClick={() => void submitFallback()}
                type="button"
              >
                Grade replacement
              </button>
            </div>
          ) : null}
          {disposition === "failed" ? (
            <button onClick={() => void nextAction()} type="button">
              {questionStage === "initial"
                ? "Generate a different lesson"
                : "Try another Tutor strategy"}
            </button>
          ) : null}
          {disposition === "correct" ? (
            <button onClick={() => void nextAction()} type="button">
              {questionStage === "retest"
                ? "Verify mastery delta"
                : "Ask Tutor for the next action"}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === "lesson" && view !== null && view.lesson !== null ? (
        <div className="flow-lesson">
          <div className="lesson-meta">
            <span>Replacement {view.lesson.replacementOrdinal}</span>
            <span>
              {view.lesson.priorStrategyTag} → {view.lesson.strategyTag}
            </span>
            <span>
              Similarity{" "}
              {Math.round(Number(view.lesson.semanticSimilarity) * 100)}%
            </span>
          </div>
          <h3>A materially different explanation</h3>
          <pre>{view.lesson.content}</pre>
          <p className="evidence-note">
            This source-backed lesson references {view.lesson.sourceSpanCount}{" "}
            authorized source span
            {view.lesson.sourceSpanCount === 1 ? "" : "s"}. Viewing it does not
            change mastery.
          </p>
          <button onClick={() => void nextAction()} type="button">
            Continue to distinct re-test
          </button>
        </div>
      ) : null}

      {phase === "summary" && view !== null ? (
        <div className="flow-summary">
          <p className="eyebrow">Persisted session summary</p>
          <h3>
            {view.loopResult?.outcome === "retest_succeeded"
              ? "The re-test evidence closed the loop."
              : "The gap is scheduled for later review."}
          </h3>
          {view.loopResult !== null ? (
            <div className="delta-hero">
              <span>{exactPercentLabel(view.loopResult.initialMastery)}</span>
              <span aria-hidden="true">→</span>
              <strong>{exactPercentLabel(view.loopResult.finalMastery)}</strong>
              <em>{masteryDeltaLabel(view.loopResult.masteryDelta)}</em>
            </div>
          ) : null}
          <p>
            The Knowledge Map refresh below reads the same persisted evidence;
            no client-side score was substituted.
          </p>
          <button onClick={onProgressRefresh} type="button">
            Refresh Knowledge Map
          </button>
        </div>
      ) : null}

      {view !== null ? (
        <form className="tutor-ask" onSubmit={askTutor}>
          <div>
            <strong>Ask the grounded Tutor</strong>
            <small>Answers cite server-resolved authorized source spans.</small>
          </div>
          <div className="tutor-input">
            <input
              onChange={(event) => setTutorQuestion(event.target.value)}
              placeholder="What should I clarify?"
              required
              value={tutorQuestion}
            />
            <button disabled={askingTutor} type="submit">
              {askingTutor ? "Checking source…" : "Ask"}
            </button>
          </div>
          {tutorAnswer?.kind === "answer" ? (
            <div className="tutor-answer">
              <p>{tutorAnswer.content}</p>
              <ol>
                {tutorAnswer.citations?.map((citation, index) => (
                  <li key={`${citation.sectionPath.join("/")}-${index}`}>
                    {citation.sectionPath.join(" › ")}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {tutorAnswer?.kind === "not_found" ? (
            <p className="tutor-not-found">
              I couldn’t verify an answer in the authorized course material.
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );

  function fail(error: unknown, fallback: string) {
    setMessage(error instanceof Error ? error.message : fallback);
    setPhase("error");
  }
}

function FlowPlan({ view }: { readonly view: ConnectedStudyView }) {
  return (
    <div className="flow-plan">
      <div>
        <span>Today’s Tutor plan</span>
        <strong>Close the gap: {view.concept.conceptName}</strong>
      </div>
      <div>
        <span>{Math.round(Number(view.concept.mastery) * 100)}% mastery</span>
        <span>{view.concept.eligibleAttemptCount} eligible attempts</span>
      </div>
    </div>
  );
}

function FlowBusy({ copy }: { readonly copy: string }) {
  return (
    <div className="flow-busy">
      <span className="loading-ring" />
      <p>{copy}</p>
    </div>
  );
}

function FlowNotice({
  copy,
  onRetry,
  title,
}: {
  readonly copy: string;
  readonly onRetry: () => void;
  readonly title: string;
}) {
  return (
    <div className="flow-notice">
      <strong>{title}</strong>
      <p>{copy}</p>
      <button onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}

async function requestJson<Value>(url: string): Promise<Value> {
  const response = await fetch(url, { credentials: "include" });
  return parseResponse<Value>(response);
}

async function requestPreflight(
  apiOrigin: string,
): Promise<ConnectedDemoPreflightView> {
  const response = await fetch(`${apiOrigin}/v1/demo/preflight`, {
    credentials: "include",
  });
  const body = (await response.json().catch(() => ({}))) as {
    readonly checkedAt?: string;
    readonly contractVersion?: string;
    readonly dependencies?: readonly ConnectedDemoPreflightDependency[];
    readonly status?: "ready" | "unavailable";
  };
  if (
    (response.status !== 200 && response.status !== 503) ||
    body.dependencies === undefined ||
    body.checkedAt === undefined ||
    body.contractVersion !== "connected-demo-preflight-v1" ||
    body.status === undefined
  ) {
    throw new Error("Connected dependency preflight could not be confirmed.");
  }
  return {
    checkedAt: body.checkedAt,
    contractVersion: body.contractVersion,
    dependencies: body.dependencies,
    status: body.status,
  };
}

async function postJson<Value>(
  apiOrigin: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<Value> {
  const csrf = await requestJson<{ csrfToken: string }>(
    `${apiOrigin}/v1/csrf-token`,
  );
  const response = await fetch(`${apiOrigin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-reflo-csrf": csrf.csrfToken,
    },
    method: "POST",
  });
  return parseResponse<Value>(response);
}

async function parseResponse<Value>(response: Response): Promise<Value> {
  const body = (await response.json().catch(() => ({}))) as {
    readonly error?: string;
  };
  if (!response.ok) {
    throw new Error(errorCopy(body.error, response.status));
  }
  return body as Value;
}

function errorCopy(code: string | undefined, status: number): string {
  if (status === 401) {
    return "Your staff demo session expired. Sign in again.";
  }
  switch (code) {
    case "grading_in_progress":
      return "This exact submission is still being graded. Try again shortly.";
    case "tutor_unavailable":
    case "assessment_unavailable":
    case "service_unavailable":
      return "A connected dependency is unavailable; no success was recorded.";
    case "retest_unavailable":
      return "A distinct source-backed re-test is unavailable.";
    default:
      return "The connected request could not be confirmed.";
  }
}

async function stableKey(
  kind: string,
  sessionId: string,
  resourceId: string,
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `dev/browser-flow-b/${kind}/v1/${sessionId}/${resourceId}/${hex}`;
}
