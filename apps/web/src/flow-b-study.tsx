"use client";

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  ConnectedDemoPreflightDependency,
  ConnectedDemoPreflightView,
  ConnectedStudyQuestion,
  ConnectedStudyView,
} from "@reflo/contracts";

import {
  activationFailurePresentation,
  activationPlanDisposition,
  assessmentAvailabilityMessage,
  assessmentDisposition,
  assessmentRequestErrorCopy,
  completedSessionTransition,
  initialStudyPhase,
  lessonMediaPresentation,
  shouldEnterPlacement,
  studyErrorRetryTarget,
  studyRetryPresentation,
  unavailableDependencyNames,
  type BrowserAssessmentResult,
  type ActivationFailure,
  type AssessmentArtifactPlan,
  type CourseActivationPlan,
  type LessonMediaState,
  type PrivatePlaybackGrant,
} from "./flow-b-view";
import { exactPercentLabel, masteryDeltaLabel } from "./account-view";
import {
  activationConnectionText,
  activationProgressText,
  createActivationProgressController,
  type ActivationProgressConnection,
  type ActivationProgressEvent,
} from "./activation-progress";
import {
  PLACEMENT_POLL_INTERVAL_MS,
  placementAnswerReady,
  placementFailureAction,
  placementProgressLabel,
  placementResultCopy,
  placementResumeState,
  shouldContinuePlacementPolling,
  validPlacementView,
  type PlacementAnswerResult,
  type PlacementView,
} from "./placement-view";
import {
  clearPlacementDraft,
  readPlacementDraft,
  storePlacementDraft,
} from "./placement-draft";

type Phase =
  | "activation_failed"
  | "blocked"
  | "checking"
  | "error"
  | "idle"
  | "lesson"
  | "placement_complete"
  | "placement_failed"
  | "placement_pending"
  | "placement_question"
  | "placement_result"
  | "preparing"
  | "question"
  | "result"
  | "submitting"
  | "summary";
type QuestionStage = "initial" | "retest";
type SubmissionRetry = "replacement" | "short_answer";

interface TutorAnswer {
  readonly citations?: readonly {
    readonly sectionPath: readonly string[];
  }[];
  readonly content?: string;
  readonly kind: "answer" | "error" | "not_found";
  readonly message?: string;
}

interface CourseStudyLesson {
  readonly concept: {
    readonly chapterId: string;
    readonly conceptId: string;
    readonly conceptName: string;
    readonly mastery: string;
  };
  readonly content: string;
  readonly courseId: string;
  readonly kind: "advance" | "review" | "reteach";
  readonly lesson: {
    readonly assetId: string;
    readonly media?: LessonMediaState | null;
    readonly modality: "audio" | "text" | "video";
    readonly servedAt: string;
    readonly sourceSpanCount: number;
    readonly strategyTag: string;
  };
  readonly sessionId: string;
  readonly sourceDocumentId: string;
}

interface StartedStudySession {
  readonly session: {
    readonly courseId: string;
    readonly plan?: CourseActivationPlan;
    readonly sessionId: string;
  };
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
  const [phase, setPhase] = useState<Phase>(() =>
    initialStudyPhase(resumeSessionId),
  );
  const [view, setView] = useState<ConnectedStudyView | null>(null);
  const [courseLesson, setCourseLesson] = useState<CourseStudyLesson | null>(
    null,
  );
  const [question, setQuestion] = useState<ConnectedStudyQuestion | null>(null);
  const [questionStage, setQuestionStage] = useState<QuestionStage>("initial");
  const [initialQuestionId, setInitialQuestionId] = useState<string | null>(
    null,
  );
  const [answer, setAnswer] = useState("");
  const [assessment, setAssessment] = useState<BrowserAssessmentResult | null>(
    null,
  );
  const [completedFromNextAction, setCompletedFromNextAction] = useState(false);
  const [nextActionRetrySessionId, setNextActionRetrySessionId] = useState<
    string | null
  >(null);
  const [submissionRetry, setSubmissionRetry] =
    useState<SubmissionRetry | null>(null);
  const [fallbackAnswer, setFallbackAnswer] = useState("");
  const [placement, setPlacement] = useState<PlacementView | null>(null);
  const [placementAnswer, setPlacementAnswer] = useState("");
  const [placementFallbackAnswer, setPlacementFallbackAnswer] = useState("");
  const [placementResult, setPlacementResult] =
    useState<PlacementAnswerResult | null>(null);
  const [placementRetrying, setPlacementRetrying] = useState(false);
  const [placementSubmitting, setPlacementSubmitting] = useState(false);
  const [placementSessionId, setPlacementSessionId] = useState<string | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [tutorQuestion, setTutorQuestion] = useState("");
  const [tutorAnswer, setTutorAnswer] = useState<TutorAnswer | null>(null);
  const [askingTutor, setAskingTutor] = useState(false);
  const [preparingSessionId, setPreparingSessionId] = useState<string | null>(
    null,
  );
  const [checkingPreparation, setCheckingPreparation] = useState(false);
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null);
  const [regenerationAvailability, setRegenerationAvailability] =
    useState<NonNullable<CourseActivationPlan["regeneration"]> | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [activationFailure, setActivationFailure] =
    useState<ActivationFailure | null>(null);
  const [assessmentStatus, setAssessmentStatus] = useState<
    "failed" | "pending" | "ready" | "retrying" | null
  >(null);
  const [assessmentArtifacts, setAssessmentArtifacts] = useState<{
    readonly chapterQuiz: AssessmentArtifactPlan;
    readonly placementQuiz: AssessmentArtifactPlan;
  } | null>(null);
  const [regeneratingAssessment, setRegeneratingAssessment] = useState<
    "chapter_quiz" | "placement_quiz" | null
  >(null);
  const [assessmentProgress, setAssessmentProgress] = useState("");
  const [activationConnection, setActivationConnection] =
    useState<ActivationProgressConnection>("idle");
  const [activationProgress, setActivationProgress] = useState(
    "Preparing your first lesson…",
  );
  const [retryAnnouncement, setRetryAnnouncement] = useState("");
  const [retryingError, setRetryingError] = useState(false);
  const focusHandoffOrigin = useRef<HTMLElement | null>(null);
  const focusHandoffRequested = useRef(false);
  const studyPanel = useRef<HTMLElement>(null);
  const transitionFocusTarget = useRef<HTMLHeadingElement>(null);
  const retryInFlight = useRef(false);
  const placementSubmissionInFlight = useRef(false);
  const tutorInputId = useId();

  useEffect(() => {
    if (phase !== "placement_question" || placement?.question == null) return;
    storePlacementDraft(
      window.sessionStorage,
      courseId,
      placement.question.id,
      placementAnswer,
    );
  }, [courseId, phase, placement, placementAnswer]);

  async function start(focusAfterReplacement = false): Promise<boolean> {
    if (focusAfterReplacement) {
      focusHandoffOrigin.current = document.activeElement as HTMLElement | null;
      focusHandoffRequested.current = true;
    }
    setPhase("checking");
    setCompletedFromNextAction(false);
    setMessage("");
    setActivationFailure(null);
    try {
      const preflight = await requestPreflight(apiOrigin);
      const studyDependencies = preflight.dependencies.filter(
        (dependency) => dependency.name !== "delivery",
      );
      const missing = unavailableDependencyNames(studyDependencies);
      if (missing.length > 0) {
        setUnavailable(missing);
        setPhase("blocked");
        return false;
      }
      setUnavailable([]);
      const started = await postJson<StartedStudySession>(
        apiOrigin,
        `/v1/courses/${encodeURIComponent(courseId)}/study-sessions`,
      );
      await applyStartedSession(started, false);
      return true;
    } catch (error) {
      fail(error, "Your study session could not be opened.");
      return false;
    }
  }

  const restoreDurableSession = useEffectEvent(async () => {
    await start();
  });

  useEffect(() => {
    if (resumeSessionId === null) return;
    const timer = window.setTimeout(() => void restoreDurableSession(), 0);
    return () => window.clearTimeout(timer);
  }, [resumeSessionId]);

  useEffect(() => {
    if (
      !focusHandoffRequested.current ||
      (phase !== "checking" && phase !== "placement_pending")
    ) {
      return;
    }
    const origin = focusHandoffOrigin.current;
    const activeElement = document.activeElement;
    if (
      (origin?.isConnected === true && activeElement !== origin) ||
      (origin?.isConnected === false && activeElement !== document.body)
    ) {
      focusHandoffRequested.current = false;
      focusHandoffOrigin.current = null;
      return;
    }
    studyPanel.current?.focus();
    focusHandoffRequested.current = false;
    focusHandoffOrigin.current = null;
  }, [phase]);

  async function checkPreparedLesson() {
    if (preparingSessionId === null || checkingPreparation) {
      return;
    }
    setCheckingPreparation(true);
    setMessage("");
    try {
      const started = await postJson<StartedStudySession>(
        apiOrigin,
        `/v1/courses/${encodeURIComponent(courseId)}/study-sessions`,
      );
      await applyStartedSession(started, true);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Course setup could not be checked right now.",
      );
      setPhase("preparing");
    } finally {
      setCheckingPreparation(false);
    }
  }

  async function applyStartedSession(
    started: StartedStudySession,
    preparationCheck: boolean,
    skipCompletedPlacement = false,
  ) {
    if (started.session.courseId !== courseId) {
      throw new Error("The study session opened for a different course.");
    }
    const plan = started.session.plan;
    setAssessmentStatus(plan?.assessmentStatus ?? null);
    setAssessmentArtifacts(plan?.assessments ?? null);
    if (!skipCompletedPlacement && shouldEnterPlacement(plan)) {
      await loadPlacement(started.session.sessionId);
      return;
    }
    const disposition = activationPlanDisposition(plan);
    if (disposition === "failed") {
      setActivationFailure(plan?.activationFailure ?? null);
      setFailedSessionId(started.session.sessionId);
      setRegenerationAvailability(plan?.regeneration ?? null);
      setPreparingSessionId(null);
      setPhase("activation_failed");
      return;
    }
    if (disposition === "pending") {
      setFailedSessionId(null);
      setRegenerationAvailability(null);
      setPreparingSessionId(started.session.sessionId);
      setActivationConnection("idle");
      setActivationProgress("Preparing your first lesson…");
      setPhase("preparing");
      return;
    }
    if (await loadPendingAssessment(started.session.sessionId)) {
      await loadView(started.session.sessionId);
      setPreparingSessionId(null);
      return;
    }
    if (await loadCourseLesson(started.session.sessionId)) {
      setPreparingSessionId(null);
      return;
    }
    if (preparationCheck) {
      throw new Error(
        "The lesson was marked ready but could not be opened. Your progress is safe.",
      );
    }
    await loadView(started.session.sessionId);
  }

  async function regenerateLesson() {
    if (
      failedSessionId === null ||
      regenerationAvailability?.eligible !== true ||
      regenerating
    ) {
      return;
    }
    setRegenerating(true);
    setMessage("");
    const requestIdempotencyKey = crypto.randomUUID();
    try {
      await postJson(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(failedSessionId)}/activation/regenerate`,
        { courseId },
        { "idempotency-key": requestIdempotencyKey },
      );
      setActivationFailure(null);
      setRegenerationAvailability(null);
      setPreparingSessionId(failedSessionId);
      setFailedSessionId(null);
      setActivationConnection("idle");
      setActivationProgress("Preparing a new version of your first lesson…");
      setPhase("preparing");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "A new lesson version could not be requested.",
      );
    } finally {
      setRegenerating(false);
    }
  }

  async function regenerateAssessment(
    artifactKind: "chapter_quiz" | "placement_quiz",
  ) {
    if (courseLesson === null || regeneratingAssessment !== null) return;
    const plan =
      artifactKind === "chapter_quiz"
        ? assessmentArtifacts?.chapterQuiz
        : assessmentArtifacts?.placementQuiz;
    if (plan?.regeneration?.eligible !== true) return;
    setRegeneratingAssessment(artifactKind);
    setMessage("");
    try {
      await postJson(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(courseLesson.sessionId)}/assessments/${artifactKind}/regenerate`,
        { courseId },
        { "idempotency-key": crypto.randomUUID() },
      );
      const pending: AssessmentArtifactPlan = {
        ...plan,
        failureClass: null,
        regeneration: null,
        regenerationOrdinal: plan.regenerationOrdinal + 1,
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      setAssessmentArtifacts((current) =>
        current === null
          ? current
          : artifactKind === "chapter_quiz"
            ? { ...current, chapterQuiz: pending }
            : { ...current, placementQuiz: pending },
      );
      if (artifactKind === "chapter_quiz") setAssessmentStatus("pending");
      setAssessmentProgress(
        artifactKind === "chapter_quiz"
          ? "Preparing new Chapter 1 practice questions…"
          : "Preparing a new placement quiz…",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "New questions could not be requested.",
      );
    } finally {
      setRegeneratingAssessment(null);
    }
  }

  const pollActivationPlan = useEffectEvent(async () => {
    const started = await postJson<StartedStudySession>(
      apiOrigin,
      `/v1/courses/${encodeURIComponent(courseId)}/study-sessions`,
    );
    const disposition = activationPlanDisposition(started.session.plan);
    await applyStartedSession(started, true);
    const placementStatus = started.session.plan?.placement?.status;
    return disposition === "pending" || placementStatus === "pending"
      ? "continue"
      : "stop";
  });

  const handleActivationEvent = useEffectEvent(
    (event: ActivationProgressEvent) => {
      setActivationProgress(activationProgressText(event));
      setAssessmentStatus(
        event.assessmentStatus === "retrying"
          ? "retrying"
          : event.assessmentStatus,
      );
      if (
        event.assessmentArtifact !== undefined &&
        event.assessmentArtifact !== null
      ) {
        const artifact = event.assessmentArtifact;
        setAssessmentProgress(
          artifact.status === "ready"
            ? artifact.artifactKind === "chapter_quiz"
              ? "Chapter 1 practice questions are ready."
              : "Your placement quiz is ready."
            : artifact.status === "failed"
              ? (artifact.failure?.message ?? "Question preparation failed.")
              : `Preparing ${artifact.artifactKind === "chapter_quiz" ? "Chapter 1 practice questions" : "your placement quiz"} · attempt ${artifact.attemptCount || 1} of ${artifact.maxAttempts}`,
        );
        setAssessmentArtifacts((current) => {
          if (current === null) return current;
          const updated: AssessmentArtifactPlan = {
            attemptCount: artifact.attemptCount,
            failureClass: artifact.failure?.code ?? null,
            regeneration: null,
            regenerationOrdinal: artifact.regenerationOrdinal,
            status: artifact.status,
            updatedAt: artifact.updatedAt,
          };
          return artifact.artifactKind === "chapter_quiz"
            ? { ...current, chapterQuiz: updated }
            : { ...current, placementQuiz: updated };
        });
        if (artifact.status === "failed") {
          // Reload only durable eligibility/cooldown metadata; this never
          // schedules generation because the lesson itself is already ready.
          void pollActivationPlan();
        }
        if (
          artifact.artifactKind === "placement_quiz" &&
          phase === "placement_pending" &&
          preparingSessionId !== null &&
          (artifact.status === "ready" || artifact.status === "failed")
        ) {
          void loadPlacement(preparingSessionId).catch((error: unknown) =>
            reportPlacementRefreshError(error),
          );
        }
      }
      if (event.activationStatus === "failed") {
        setActivationFailure({
          artifactKind: "first_text_lesson",
          attemptCount: event.attemptCount,
          failureClass: event.failure?.code ?? null,
          retryable: false,
          updatedAt: event.updatedAt,
        });
        setFailedSessionId(preparingSessionId);
        setRegenerationAvailability(null);
        setPreparingSessionId(null);
        setActivationConnection("idle");
        setPhase("activation_failed");
        // The terminal stream snapshot is enough to leave the connecting UI.
        // Refresh the plan only to obtain durable regeneration eligibility.
        void pollActivationPlan();
        return;
      }
      if (
        event.activationStatus === "ready" &&
        phase === "preparing" &&
        preparingSessionId !== null
      ) {
        setAssessmentStatus(
          event.assessmentStatus === "retrying"
            ? "pending"
            : event.assessmentStatus,
        );
        void loadCourseLesson(preparingSessionId).then((loaded) => {
          if (!loaded) {
            setActivationConnection("offline");
            setMessage(
              "The lesson is ready but could not be opened automatically.",
            );
          }
        });
      }
    },
  );

  const assessmentStreaming =
    assessmentStatus === "pending" ||
    assessmentStatus === "retrying" ||
    assessmentArtifacts?.chapterQuiz.status === "pending" ||
    assessmentArtifacts?.chapterQuiz.status === "retrying" ||
    assessmentArtifacts?.placementQuiz.status === "pending" ||
    assessmentArtifacts?.placementQuiz.status === "retrying";

  useEffect(() => {
    const progressSessionId = preparingSessionId ?? courseLesson?.sessionId;
    if (
      progressSessionId === null ||
      progressSessionId === undefined ||
      (phase !== "preparing" &&
        phase !== "placement_pending" &&
        !(phase === "lesson" && assessmentStreaming))
    )
      return;
    const controller = createActivationProgressController({
      createEventSource: () =>
        new EventSource(
          `${apiOrigin}/v1/study-sessions/${encodeURIComponent(progressSessionId)}/activation/events`,
          { withCredentials: true },
        ),
      isVisible: () => document.visibilityState === "visible",
      onConnectionChange: setActivationConnection,
      onEvent: handleActivationEvent,
      poll: pollActivationPlan,
    });
    return () => controller.stop();
  }, [
    apiOrigin,
    assessmentStreaming,
    courseId,
    courseLesson?.sessionId,
    phase,
    preparingSessionId,
  ]);

  const pollPlacementStatus = useEffectEvent(async (sessionId: string) =>
    loadPlacement(sessionId),
  );

  useEffect(() => {
    if (phase !== "placement_pending" || placementSessionId === null) return;
    let cancelled = false;
    let completedPolls = 0;
    let handle: number | null = null;
    const schedule = () => {
      if (cancelled || handle !== null) return;
      handle = window.setTimeout(() => {
        handle = null;
        if (cancelled) return;
        completedPolls += 1;
        void pollPlacementStatus(placementSessionId)
          .then((latest) => {
            if (
              !cancelled &&
              shouldContinuePlacementPolling(latest.status, completedPolls)
            ) {
              schedule();
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            reportPlacementRefreshError(error);
            if (shouldContinuePlacementPolling("pending", completedPolls)) {
              schedule();
            }
          });
      }, PLACEMENT_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (handle !== null) window.clearTimeout(handle);
    };
  }, [phase, placementSessionId]);

  async function loadView(sessionId: string) {
    const loaded = await requestJson<{ view: ConnectedStudyView }>(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/state`,
    );
    if (loaded.view.courseId !== courseId) {
      setView(null);
      throw new Error("This session belongs to a different course.");
    }
    setView(loaded.view);
    setCourseLesson(null);
    if (await loadPendingAssessment(sessionId)) return;
    if (loaded.view.state === "lesson_unavailable") {
      throw new Error(
        "This lesson is temporarily unavailable. Your progress is unchanged.",
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
      throw new Error("The next question is not available yet.");
    }
    showQuestion(loaded.view.question, "initial");
  }

  async function loadPlacement(sessionId: string): Promise<PlacementView> {
    const loaded = await requestJson<{ placement: PlacementView }>(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/placement`,
    );
    if (!validPlacementView(loaded.placement)) {
      throw new Error("Placement status could not be verified.");
    }
    setMessage("");
    const restoredDraft =
      loaded.placement.question === null
        ? ""
        : readPlacementDraft(
            window.sessionStorage,
            courseId,
            loaded.placement.question,
          );
    setPlacement(loaded.placement);
    setPlacementSessionId(sessionId);
    setCourseLesson(null);
    setView(null);
    setAssessment(null);
    setPlacementResult(null);
    setPlacementAnswer(restoredDraft);
    setPlacementFallbackAnswer("");
    if (loaded.placement.status === "pending") {
      setPreparingSessionId(sessionId);
      setActivationConnection("idle");
      setAssessmentProgress("Preparing your 10-question placement quiz…");
      setPhase("placement_pending");
      return loaded.placement;
    }
    setPreparingSessionId(null);
    if (loaded.placement.status === "failed") {
      setPhase("placement_failed");
      return loaded.placement;
    }
    if (loaded.placement.status === "complete") {
      setPhase("placement_complete");
      onProgressRefresh();
      return loaded.placement;
    }
    const pendingAssessment = await requestJson<{
      readonly result: BrowserAssessmentResult | null;
    }>(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/assessments/pending-fallback`,
    );
    if (
      placementResumeState(loaded.placement, pendingAssessment.result) ===
        "result" &&
      pendingAssessment.result !== null
    ) {
      setPlacementResult({
        assessment: pendingAssessment.result,
        kind: "short_answer",
      });
      setPhase("placement_result");
      return loaded.placement;
    }
    setPhase("placement_question");
    return loaded.placement;
  }

  function reportPlacementRefreshError(error: unknown) {
    setMessage(
      error instanceof Error
        ? error.message
        : "Placement status could not be refreshed.",
    );
    setActivationConnection("offline");
    setRetryAnnouncement(
      "Placement refresh failed. The saved placement state is unchanged.",
    );
  }

  async function refreshPlacement() {
    if (placementSessionId === null || placementRetrying) return;
    setPlacementRetrying(true);
    setRetryAnnouncement("Refreshing placement status…");
    try {
      await loadPlacement(placementSessionId);
      setRetryAnnouncement("Placement status refreshed.");
    } catch (error) {
      reportPlacementRefreshError(error);
    } finally {
      setPlacementRetrying(false);
    }
  }

  async function regeneratePlacement() {
    if (placementSessionId === null || placementRetrying) return;
    studyPanel.current?.focus();
    setPlacementRetrying(true);
    setRetryAnnouncement("Requesting a new placement quiz…");
    try {
      await postJson(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(placementSessionId)}/assessments/placement_quiz/regenerate`,
        { courseId },
        { "idempotency-key": crypto.randomUUID() },
      );
      setMessage("");
      setAssessmentProgress("Preparing a new 10-question placement quiz…");
      setPreparingSessionId(placementSessionId);
      setPhase("placement_pending");
      setRetryAnnouncement("A new placement quiz was requested.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "A new placement quiz could not be requested.",
      );
      setRetryAnnouncement(
        "Placement regeneration failed. The latest error is shown.",
      );
    } finally {
      setPlacementRetrying(false);
    }
  }

  async function submitPlacementAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const placementQuestion = placement?.question ?? null;
    if (
      placementSubmissionInFlight.current ||
      placementSessionId === null ||
      !placementAnswerReady(placementQuestion, placementAnswer)
    ) {
      return;
    }
    placementSubmissionInFlight.current = true;
    setPlacementSubmitting(true);
    setMessage("");
    try {
      if (placementQuestion!.itemType === "short_answer") {
        const response = await postJson<{ result: BrowserAssessmentResult }>(
          apiOrigin,
          `/v1/study-sessions/${encodeURIComponent(placementSessionId)}/answers/short-answer`,
          {
            answer: placementAnswer,
            idempotencyKey: await stableKey(
              "placement-short-answer",
              placementSessionId,
              placementQuestion!.id,
              placementAnswer,
            ),
            questionId: placementQuestion!.id,
          },
        );
        setPlacementResult({
          assessment: response.result,
          kind: "short_answer",
        });
        if (assessmentDisposition(response.result) !== "abstained") {
          onProgressRefresh();
        }
      } else {
        const response = await postJson<{
          result: {
            readonly correct: boolean;
            readonly status: "created" | "replayed";
          };
        }>(
          apiOrigin,
          `/v1/study-sessions/${encodeURIComponent(placementSessionId)}/placement/answers`,
          {
            answer: placementAnswer,
            idempotencyKey: await stableKey(
              "placement-keyed-answer",
              placementSessionId,
              placementQuestion!.id,
              placementAnswer,
            ),
            questionId: placementQuestion!.id,
          },
        );
        setPlacementResult({ kind: "keyed", ...response.result });
        onProgressRefresh();
      }
      clearPlacementDraft(
        window.sessionStorage,
        courseId,
        placementQuestion!.id,
      );
      setPhase("placement_result");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Your placement answer was not confirmed. Retrying is safe.",
      );
    } finally {
      placementSubmissionInFlight.current = false;
      setPlacementSubmitting(false);
    }
  }

  async function submitPlacementFallback() {
    if (
      placementSessionId === null ||
      placementResult?.kind !== "short_answer" ||
      placementSubmissionInFlight.current ||
      placementFallbackAnswer === ""
    ) {
      return;
    }
    const bundle = placementResult.assessment.fallback;
    const item = bundle?.items[0];
    if (bundle === null || bundle === undefined || item === undefined) return;
    placementSubmissionInFlight.current = true;
    setPlacementSubmitting(true);
    setMessage("");
    try {
      const response = await postJson<{ result: BrowserAssessmentResult }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(placementSessionId)}/answers/replacement`,
        {
          answer: placementFallbackAnswer,
          bundleId: bundle.id,
          idempotencyKey: await stableKey(
            "placement-replacement",
            placementSessionId,
            item.id,
            placementFallbackAnswer,
          ),
          itemId: item.id,
        },
      );
      setPlacementResult({ assessment: response.result, kind: "short_answer" });
      onProgressRefresh();
      setPhase("placement_result");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The replacement answer was not confirmed. Retrying is safe.",
      );
    } finally {
      placementSubmissionInFlight.current = false;
      setPlacementSubmitting(false);
    }
  }

  async function continueAfterPlacement() {
    if (placementSessionId === null) return;
    setPhase("checking");
    setMessage("");
    try {
      const started = await postJson<StartedStudySession>(
        apiOrigin,
        `/v1/courses/${encodeURIComponent(courseId)}/study-sessions`,
      );
      await applyStartedSession(started, false, true);
    } catch (error) {
      fail(error, "Your first lesson could not be opened.");
    }
  }

  async function loadPendingAssessment(sessionId: string): Promise<boolean> {
    const pendingAssessment = await requestJson<{
      readonly result: BrowserAssessmentResult | null;
    }>(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/assessments/pending-fallback`,
    );
    if (pendingAssessment.result === null) return false;
    setAssessment(pendingAssessment.result);
    setSubmissionRetry(null);
    setPhase("result");
    return true;
  }

  async function loadCourseLesson(sessionId: string): Promise<boolean> {
    const response = await fetch(
      `${apiOrigin}/v1/study-sessions/${encodeURIComponent(sessionId)}/lesson`,
      { credentials: "include" },
    );
    if (response.status === 404) {
      return false;
    }
    const loaded = await parseResponse<{ lesson: CourseStudyLesson }>(response);
    if (loaded.lesson.courseId !== courseId) {
      throw new Error("This lesson belongs to a different course.");
    }
    setCourseLesson(loaded.lesson);
    setView(null);
    setAssessment(null);
    setPhase("lesson");
    return true;
  }

  function showQuestion(
    nextQuestion: ConnectedStudyQuestion,
    stage: QuestionStage,
  ) {
    setCompletedFromNextAction(false);
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
    await gradeShortAnswer();
  }

  async function gradeShortAnswer(): Promise<boolean> {
    if (view === null || question === null || answer.trim() === "") {
      return false;
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
      setSubmissionRetry(null);
      setPhase("result");
      return true;
    } catch (error) {
      setSubmissionRetry("short_answer");
      fail(error, "The answer was not confirmed. Retrying is replay-safe.", {
        preserveSubmissionRetry: true,
      });
      return false;
    }
  }

  async function submitFallback(): Promise<boolean> {
    const bundle = assessment?.fallback;
    const item = bundle?.items[0];
    if (
      view === null ||
      bundle === null ||
      bundle === undefined ||
      item === undefined ||
      fallbackAnswer === ""
    ) {
      return false;
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
      setSubmissionRetry(null);
      setPhase("result");
      return true;
    } catch (error) {
      setSubmissionRetry("replacement");
      fail(
        error,
        "The replacement answer was not confirmed. Retrying is replay-safe.",
        { preserveSubmissionRetry: true },
      );
      return false;
    }
  }

  async function retryStudyError() {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetryingError(true);
    setRetryAnnouncement("Retrying your saved activity…");
    const target = studyErrorRetryTarget({
      courseLessonSessionId: courseLesson?.sessionId ?? null,
      nextActionSessionId: nextActionRetrySessionId,
      submissionRetry,
      viewSessionId: view?.sessionId ?? null,
    });
    try {
      let recovered = false;
      if (target.kind === "short_answer") {
        recovered = await gradeShortAnswer();
      } else if (target.kind === "replacement") {
        recovered = await submitFallback();
      } else if (target.kind === "course_lesson") {
        recovered = await loadCourseLesson(target.sessionId);
        if (!recovered) {
          throw new Error("The lesson remains unavailable.");
        }
      } else if (target.kind === "next_action") {
        recovered = await nextAction(target.sessionId);
      } else if (target.kind === "idle") {
        recovered = await start(true);
      } else {
        await loadView(target.sessionId);
        recovered = true;
      }
      setRetryAnnouncement(
        recovered
          ? "Retry succeeded. Your saved activity is ready."
          : "Retry failed. The latest error is shown.",
      );
    } catch (error) {
      const fallback =
        target.kind === "course_lesson"
          ? "The lesson remains unavailable."
          : "The persisted study state remains unavailable.";
      fail(error, fallback);
      setRetryAnnouncement("Retry failed. The latest error is shown.");
    } finally {
      retryInFlight.current = false;
      setRetryingError(false);
    }
  }

  async function nextAction(retrySessionId?: string): Promise<boolean> {
    const sessionId =
      retrySessionId ?? view?.sessionId ?? courseLesson?.sessionId;
    if (sessionId === undefined) {
      return false;
    }
    setNextActionRetrySessionId(null);
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
      }>(apiOrigin, `/v1/study-sessions/${encodeURIComponent(sessionId)}/next`);
      const completion = completedSessionTransition(response.action.kind);
      if (completion !== null) {
        setCompletedFromNextAction(true);
        setPhase(completion.phase);
        if (completion.refreshProgress) {
          onProgressRefresh();
        }
        return true;
      }
      if (response.action.kind === "reteach") {
        await loadView(sessionId);
        return true;
      }
      if (response.action.kind === "retest") {
        showQuestion(response.action.question, "retest");
        return true;
      }
      if (
        response.action.kind === "retest_succeeded" ||
        response.action.kind === "review_scheduled" ||
        response.action.kind === "advance" ||
        response.action.kind === "review"
      ) {
        if (
          (response.action.kind === "advance" ||
            response.action.kind === "review") &&
          (await loadCourseLesson(sessionId))
        ) {
          return true;
        }
        await loadView(sessionId);
        if (
          response.action.kind === "retest_succeeded" ||
          response.action.kind === "review_scheduled"
        ) {
          onProgressRefresh();
        }
        return true;
      }
      throw new Error("The next activity could not be selected.");
    } catch (error) {
      setNextActionRetrySessionId(sessionId);
      fail(error, "The next activity could not be opened.");
      return false;
    }
  }

  async function completeCourseLesson() {
    if (courseLesson === null) {
      return;
    }
    setPhase("checking");
    try {
      const idempotencyKey = await stableKey(
        "lesson-completed",
        courseLesson.sessionId,
        courseLesson.lesson.assetId,
        courseLesson.concept.conceptId,
      );
      await postJson<{ readonly completed: true }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(courseLesson.sessionId)}/lesson/complete`,
        {
          assetId: courseLesson.lesson.assetId,
          conceptId: courseLesson.concept.conceptId,
          idempotencyKey,
        },
      );
      await loadView(courseLesson.sessionId);
    } catch (error) {
      fail(error, "The lesson could not be completed. Your progress is safe.");
    }
  }

  async function askTutor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const context =
      view === null
        ? courseLesson
        : {
            courseId: view.courseId,
            sessionId: view.sessionId,
            sourceDocumentId: view.sourceDocumentId,
          };
    if (context === null || tutorQuestion.trim() === "") {
      return;
    }
    setAskingTutor(true);
    setTutorAnswer(null);
    try {
      const request = await tutorQuestionRequest(
        context,
        tutorQuestion,
        question?.itemId,
      );
      const response = await postJson<{ answer: TutorAnswer }>(
        apiOrigin,
        `/v1/study-sessions/${encodeURIComponent(context.sessionId)}/ask`,
        request,
      );
      setTutorAnswer(response.answer);
    } catch (error) {
      setTutorAnswer({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The Tutor is temporarily unavailable.",
      });
    } finally {
      setAskingTutor(false);
    }
  }

  const disposition =
    assessment === null ? null : assessmentDisposition(assessment);
  const fallback = assessment?.fallback?.items[0] ?? null;
  const activationFailureCopy =
    activationFailurePresentation(activationFailure);
  const assessmentMessage = assessmentAvailabilityMessage(
    assessmentStatus === "retrying" ? "pending" : assessmentStatus,
  );
  const chapterQuizPlan = assessmentArtifacts?.chapterQuiz ?? null;
  const placementQuizPlan = assessmentArtifacts?.placementQuiz ?? null;
  const activationConnectionCopy =
    activationConnectionText(activationConnection);
  const retryPresentation = studyRetryPresentation(retryingError);
  const placementQuestion = placement?.question ?? null;
  const placementAssessment =
    placementResult?.kind === "short_answer"
      ? placementResult.assessment
      : null;
  const placementAssessmentDisposition =
    placementAssessment === null
      ? null
      : assessmentDisposition(placementAssessment);
  const placementFallback = placementAssessment?.fallback?.items[0] ?? null;
  const placementFailurePresentation = placementFailureAction(
    placementQuizPlan?.regeneration,
  );
  const transitionAnnouncement = studyTransitionAnnouncement({
    assessment,
    disposition,
    message,
    phase,
    placement,
    placementAssessmentDisposition,
    placementResult,
    questionStage,
    retryAnnouncement,
  });
  const transitionFocusKey = [
    phase,
    placement?.question?.id ?? "",
    placementResult === null ? "" : placementResultCopy(placementResult),
    assessment?.attemptId ?? "",
    question?.itemId ?? "",
    message,
  ].join(":");

  useEffect(() => {
    if (
      phase === "checking" ||
      phase === "placement_pending" ||
      phase === "preparing" ||
      phase === "submitting" ||
      document.activeElement !== document.body
    ) {
      return;
    }
    (transitionFocusTarget.current ?? studyPanel.current)?.focus();
  }, [phase, transitionFocusKey]);

  return (
    <section
      className="panel flow-panel"
      id="study-session"
      aria-busy={
        phase === "checking" ||
        phase === "submitting" ||
        placementSubmitting ||
        retryPresentation.ariaBusy
      }
      aria-labelledby="study-title"
      ref={studyPanel}
      tabIndex={-1}
    >
      <p
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {transitionAnnouncement || retryPresentation.announcement}
      </p>
      <div className="flow-heading">
        <div>
          <p className="eyebrow">Today’s session</p>
          <h2 id="study-title">Study what matters next</h2>
          <p>
            Reflo uses your recent answers and review schedule to choose a
            focused next step.
          </p>
        </div>
      </div>

      {phase === "idle" ? (
        <div className="flow-start">
          <div>
            <strong>
              {resumeSessionId === null
                ? "Ready for a focused session?"
                : "Your session is ready to continue."}
            </strong>
            <p>
              Work through one concept at a time. If an explanation does not
              click, Reflo will try a different approach and check again.
            </p>
          </div>
          <div className="flow-actions">
            <button onClick={() => void start(true)} type="button">
              {resumeSessionId === null
                ? "Start today’s session"
                : "Continue studying"}
            </button>
          </div>
        </div>
      ) : null}

      {phase === "checking" ? (
        <FlowBusy copy="Preparing your next activity…" />
      ) : null}

      {phase === "preparing" ? (
        <div className="flow-notice" role="status" aria-live="polite">
          <strong>Your first lesson is getting ready.</strong>
          <p>{message || activationProgress}</p>
          {activationConnectionCopy === null ? null : (
            <small>{activationConnectionCopy}</small>
          )}
          {activationConnection === "offline" ? (
            <button
              disabled={checkingPreparation}
              onClick={() => void checkPreparedLesson()}
              type="button"
            >
              {checkingPreparation ? "Refreshing…" : "Refresh status"}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === "placement_pending" && placement !== null ? (
        <div className="flow-notice" role="status" aria-live="polite">
          <strong>Your placement quiz is getting ready.</strong>
          <p>{assessmentProgress || placementProgressLabel(placement)}</p>
          {message === "" ? null : <p role="alert">{message}</p>}
          {activationConnectionCopy === null ? null : (
            <small>{activationConnectionCopy}</small>
          )}
          <button
            disabled={placementRetrying}
            onClick={() => void refreshPlacement()}
            type="button"
          >
            {placementRetrying ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
      ) : null}

      {phase === "placement_failed" && placement !== null ? (
        <div className="flow-notice" role="alert">
          <strong>Your placement quiz couldn’t be prepared.</strong>
          <p>
            {message ||
              placement.failure?.message ||
              "Question preparation stopped. Your progress is unchanged."}
          </p>
          {placement.failure?.updatedAt === null ||
          placement.failure?.updatedAt === undefined ? null : (
            <small>
              Last checked{" "}
              <time dateTime={placement.failure.updatedAt}>
                {new Date(placement.failure.updatedAt).toLocaleString()}
              </time>
            </small>
          )}
          <p>{placementFailurePresentation.guidance}</p>
          <button
            disabled={placementRetrying}
            onClick={() =>
              void (placementFailurePresentation.action === "regenerate"
                ? regeneratePlacement()
                : refreshPlacement())
            }
            type="button"
          >
            {placementRetrying
              ? placementFailurePresentation.action === "regenerate"
                ? "Requesting…"
                : "Refreshing…"
              : placementFailurePresentation.action === "regenerate"
                ? "Regenerate placement quiz"
                : "Refresh status"}
          </button>
        </div>
      ) : null}

      {phase === "placement_question" &&
      placement !== null &&
      placementQuestion !== null ? (
        <form className="flow-question" onSubmit={submitPlacementAnswer}>
          <p className="question-stage">{placementProgressLabel(placement)}</p>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {placementQuestion.prompt}
          </h3>
          {placementQuestion.itemType === "short_answer" ? (
            <>
              <label htmlFor="placement-answer">Your answer</label>
              <textarea
                id="placement-answer"
                onChange={(event) => setPlacementAnswer(event.target.value)}
                required
                rows={4}
                value={placementAnswer}
              />
            </>
          ) : (
            <fieldset>
              <legend>Choose the best source-backed answer</legend>
              {placementQuestion.responseOptions?.map((option) => (
                <label className="choice-row" key={option}>
                  <input
                    checked={placementAnswer === option}
                    name="placement-answer"
                    onChange={() => setPlacementAnswer(option)}
                    required
                    type="radio"
                  />
                  <span>{option}</span>
                </label>
              ))}
            </fieldset>
          )}
          <button
            disabled={
              placementSubmitting ||
              !placementAnswerReady(placementQuestion, placementAnswer)
            }
            type="submit"
          >
            {placementSubmitting ? "Checking…" : "Check my answer"}
          </button>
          {message === "" ? null : <p role="alert">{message}</p>}
        </form>
      ) : null}

      {phase === "placement_result" && placementResult !== null ? (
        <div className="flow-result">
          <p className="question-stage">
            {placement === null
              ? "Placement"
              : placementProgressLabel(placement)}
          </p>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {placementResultCopy(placementResult)}
          </h3>
          {placementAssessmentDisposition === "abstained" &&
          placementFallback !== null ? (
            <div className="fallback-card">
              <strong>Choose the best answer instead</strong>
              <fieldset className="fallback-choices">
                <legend>{placementFallback.question.prompt}</legend>
                {placementFallback.question.responseOptions.map((option) => (
                  <label className="choice-row" key={option}>
                    <input
                      checked={placementFallbackAnswer === option}
                      name="placement-fallback"
                      onChange={() => setPlacementFallbackAnswer(option)}
                      type="radio"
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </fieldset>
              <button
                disabled={placementSubmitting || placementFallbackAnswer === ""}
                onClick={() => void submitPlacementFallback()}
                type="button"
              >
                {placementSubmitting ? "Checking…" : "Check answer"}
              </button>
            </div>
          ) : (
            <button
              disabled={placementRetrying}
              onClick={() => void refreshPlacement()}
              type="button"
            >
              {placementRetrying
                ? "Loading next question…"
                : "Next placement question"}
            </button>
          )}
          {message === "" ? null : <p role="alert">{message}</p>}
        </div>
      ) : null}

      {phase === "placement_complete" && placement !== null ? (
        <div className="flow-summary">
          <p className="eyebrow">{placementProgressLabel(placement)}</p>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            Your initial Knowledge Map is ready.
          </h3>
          <p>
            Reflo used your confidently graded answers to choose what to study
            next. The map below reflects that evidence.
          </p>
          <button onClick={() => void continueAfterPlacement()} type="button">
            Continue to the first lesson
          </button>
        </div>
      ) : null}

      {phase === "activation_failed" ? (
        <div className="flow-notice" role="alert">
          <strong>This lesson couldn’t be prepared.</strong>
          <p>{activationFailureCopy.copy}</p>
          {activationFailureCopy.updatedAt === null ? null : (
            <small>
              Last checked{" "}
              <time dateTime={activationFailureCopy.updatedAt}>
                {new Date(activationFailureCopy.updatedAt).toLocaleString()}
              </time>
            </small>
          )}
          {activationFailureCopy.retryable ? (
            <button onClick={() => void start(true)} type="button">
              Try again
            </button>
          ) : regenerationAvailability?.eligible === true ? (
            <>
              <p>
                Requesting regeneration creates a new lesson version. The failed
                version and your learning progress stay unchanged.
              </p>
              <button
                disabled={regenerating}
                onClick={() => void regenerateLesson()}
                type="button"
              >
                {regenerating ? "Requesting…" : "Regenerate lesson"}
              </button>
              {message === "" ? null : <p role="alert">{message}</p>}
            </>
          ) : (
            <p>{activationFailureCopy.guidance}</p>
          )}
        </div>
      ) : null}

      {phase === "blocked" ? (
        <FlowNotice
          title="A required dependency is unavailable."
          copy={`Study is temporarily paused while ${friendlyDependencyList(unavailable)} recovers. Your progress is safe.`}
          onRetry={() => void start(true)}
        />
      ) : null}

      {phase === "error" ? (
        <FlowNotice
          actionDisabled={retryPresentation.actionDisabled}
          actionLabel={retryPresentation.actionLabel}
          title="The loop paused safely."
          copy={message}
          onRetry={() => void retryStudyError()}
        />
      ) : null}

      {phase === "question" && view !== null && question !== null ? (
        <form className="flow-question" onSubmit={submitAnswer}>
          <FlowPlan view={view} />
          <p className="question-stage">
            {questionStage === "initial" ? "Quick check" : "Try it again"}
          </p>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {question.prompt}
          </h3>
          <label htmlFor="flow-answer">Your answer</label>
          <textarea
            id="flow-answer"
            onChange={(event) => setAnswer(event.target.value)}
            required
            rows={4}
            value={answer}
          />
          <button type="submit">
            {questionStage === "initial" ? "Check my answer" : "Check again"}
          </button>
        </form>
      ) : null}

      {phase === "submitting" ? (
        <FlowBusy copy="Checking your answer…" />
      ) : null}

      {phase === "result" && assessment !== null ? (
        <div className="flow-result">
          <span className={`evidence-pill evidence-${disposition}`}>
            {disposition === "abstained"
              ? "Another question will help"
              : disposition === "correct"
                ? "Correct"
                : disposition === "failed"
                  ? "Let’s work on this"
                  : "Answer recorded"}
          </span>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {assessment.learnerMessage}
          </h3>
          <p>
            {assessment.status === "replayed"
              ? "We found your earlier submission and kept a single result."
              : "Your answer has been added to this session."}
          </p>
          {disposition === "abstained" && fallback !== null ? (
            <div className="fallback-card">
              <strong>Choose the best answer instead</strong>
              <fieldset className="fallback-choices">
                <legend>{fallback.question.prompt}</legend>
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
              </fieldset>
              <button
                disabled={fallbackAnswer === ""}
                onClick={() => void submitFallback()}
                type="button"
              >
                Check answer
              </button>
            </div>
          ) : null}
          {disposition === "failed" ? (
            <button onClick={() => void nextAction()} type="button">
              {questionStage === "initial"
                ? "Show me another way"
                : "Review this again"}
            </button>
          ) : null}
          {disposition === "correct" ? (
            <button onClick={() => void nextAction()} type="button">
              {questionStage === "retest" ? "See my progress" : "Continue"}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === "lesson" && courseLesson !== null ? (
        <article className="flow-lesson">
          <FlowPlanFromLesson lesson={courseLesson} />
          <div className="lesson-meta">
            <span>
              {courseLesson.kind === "review"
                ? "Review"
                : courseLesson.kind === "reteach"
                  ? "Another explanation"
                  : "Next lesson"}
            </span>
            <span>
              {courseLesson.lesson.modality === "text"
                ? "Reading"
                : courseLesson.lesson.modality === "audio"
                  ? "Audio lesson"
                  : "Video lesson"}
            </span>
          </div>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {courseLesson.concept.conceptName}
          </h3>
          <LessonMedia
            apiOrigin={apiOrigin}
            key={courseLesson.lesson.assetId}
            lesson={courseLesson}
          />
          <p className="evidence-note">
            Based on {courseLesson.lesson.sourceSpanCount} course reference
            {courseLesson.lesson.sourceSpanCount === 1 ? "" : "s"}.
          </p>
          {assessmentMessage === null ? null : (
            <div className="assessment-availability" role="status">
              <p>{assessmentProgress || assessmentMessage}</p>
              {chapterQuizPlan?.status === "failed" &&
              chapterQuizPlan.regeneration?.eligible === true ? (
                <button
                  disabled={regeneratingAssessment !== null}
                  onClick={() => void regenerateAssessment("chapter_quiz")}
                  type="button"
                >
                  {regeneratingAssessment === "chapter_quiz"
                    ? "Requesting…"
                    : "Regenerate practice questions"}
                </button>
              ) : null}
              {placementQuizPlan?.status === "failed" &&
              placementQuizPlan.regeneration?.eligible === true ? (
                <details>
                  <summary>Placement quiz status</summary>
                  <p>
                    Placement-quiz preparation failed separately from this
                    chapter’s practice questions.
                  </p>
                  <button
                    disabled={regeneratingAssessment !== null}
                    onClick={() => void regenerateAssessment("placement_quiz")}
                    type="button"
                  >
                    {regeneratingAssessment === "placement_quiz"
                      ? "Requesting…"
                      : "Regenerate placement quiz"}
                  </button>
                </details>
              ) : null}
              {message === "" ? null : <p role="alert">{message}</p>}
            </div>
          )}
          {assessmentMessage === null &&
          placementQuizPlan?.status === "failed" &&
          placementQuizPlan.regeneration?.eligible === true ? (
            <details className="assessment-availability">
              <summary>Placement quiz status</summary>
              <p>
                Placement-quiz preparation failed separately from this chapter’s
                practice questions.
              </p>
              <button
                disabled={regeneratingAssessment !== null}
                onClick={() => void regenerateAssessment("placement_quiz")}
                type="button"
              >
                {regeneratingAssessment === "placement_quiz"
                  ? "Requesting…"
                  : "Regenerate placement quiz"}
              </button>
            </details>
          ) : null}
          <button
            disabled={
              assessmentStatus === "pending" ||
              assessmentStatus === "retrying" ||
              assessmentStatus === "failed"
            }
            onClick={() => void completeCourseLesson()}
            type="button"
          >
            {assessmentStatus === "pending" || assessmentStatus === "retrying"
              ? "Questions are being prepared"
              : assessmentStatus === "failed"
                ? "Questions unavailable"
                : "Continue"}
          </button>
        </article>
      ) : null}

      {phase === "lesson" && view !== null && view.lesson !== null ? (
        <div className="flow-lesson">
          <div className="lesson-meta">
            <span>Another way to learn this</span>
            <span>Explanation {view.lesson.replacementOrdinal}</span>
          </div>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            Here’s another way to look at it
          </h3>
          <pre>{view.lesson.content}</pre>
          <p className="evidence-note">
            Based on {view.lesson.sourceSpanCount} course reference
            {view.lesson.sourceSpanCount === 1 ? "" : "s"}.
          </p>
          <details className="lesson-details">
            <summary>Why this explanation is different</summary>
            <p>
              Reflo changed the teaching approach before asking a new question.
              Your mastery changes only after an assessed answer.
            </p>
          </details>
          <button onClick={() => void nextAction()} type="button">
            Try a new question
          </button>
        </div>
      ) : null}

      {phase === "summary" && view !== null ? (
        <div className="flow-summary">
          <p className="eyebrow">Session summary</p>
          <h3 ref={transitionFocusTarget} tabIndex={-1}>
            {view.loopResult?.outcome === "retest_succeeded"
              ? "Nice work—the new explanation helped."
              : completedFromNextAction || view.state === "complete"
                ? "Session complete."
                : "We’ll revisit this concept later."}
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
            {completedFromNextAction || view.state === "complete"
              ? "Your answer was recorded and your Knowledge Map is up to date."
              : "Your Knowledge Map now reflects the answers from this session."}
          </p>
          <button onClick={onProgressRefresh} type="button">
            View updated progress
          </button>
        </div>
      ) : null}

      {view !== null || courseLesson !== null ? (
        <form className="tutor-ask" onSubmit={askTutor}>
          <div>
            <strong>Ask Tutor</strong>
            <small>
              Answers are grounded in this course’s source material.
            </small>
          </div>
          <div className="tutor-input">
            <label className="visually-hidden" htmlFor={tutorInputId}>
              Question for Tutor
            </label>
            <input
              aria-describedby={`${tutorInputId}-help`}
              id={tutorInputId}
              onChange={(event) => setTutorQuestion(event.target.value)}
              placeholder="What would you like clarified?"
              required
              value={tutorQuestion}
            />
            <button disabled={askingTutor} type="submit">
              {askingTutor ? "Finding an answer…" : "Ask"}
            </button>
          </div>
          <span className="visually-hidden" id={`${tutorInputId}-help`}>
            Tutor searches only within the selected course.
          </span>
          {tutorAnswer?.kind === "answer" ? (
            <div className="tutor-answer" aria-live="polite">
              <p>{tutorAnswer.content}</p>
              <ol>
                {tutorAnswer.citations?.map((citation, index) => (
                  <li key={`${citation.sectionPath.join("/")}-${index}`}>
                    {tutorCitationLabel(citation.sectionPath, index)}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {tutorAnswer?.kind === "not_found" ? (
            <p className="tutor-not-found" aria-live="polite">
              I couldn’t find a reliable answer in this course material. Try
              asking about a specific chapter or concept.
            </p>
          ) : null}
          {tutorAnswer?.kind === "error" ? (
            <div className="tutor-error" role="alert">
              <p>{tutorAnswer.message}</p>
              <button
                className="secondary-button"
                disabled={askingTutor}
                type="submit"
              >
                Try again
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );

  function fail(
    error: unknown,
    fallback: string,
    options: { readonly preserveSubmissionRetry?: boolean } = {},
  ) {
    if (options.preserveSubmissionRetry !== true) {
      setSubmissionRetry(null);
    }
    setMessage(error instanceof Error ? error.message : fallback);
    setPhase("error");
  }
}

function studyTransitionAnnouncement({
  assessment,
  disposition,
  message,
  phase,
  placement,
  placementAssessmentDisposition,
  placementResult,
  questionStage,
  retryAnnouncement,
}: {
  readonly assessment: BrowserAssessmentResult | null;
  readonly disposition: ReturnType<typeof assessmentDisposition> | null;
  readonly message: string;
  readonly phase: Phase;
  readonly placement: PlacementView | null;
  readonly placementAssessmentDisposition: ReturnType<
    typeof assessmentDisposition
  > | null;
  readonly placementResult: PlacementAnswerResult | null;
  readonly questionStage: QuestionStage;
  readonly retryAnnouncement: string;
}): string {
  if (phase === "error") return "";
  if (phase === "placement_question" && placement !== null) {
    return `${placementProgressLabel(placement)} loaded.`;
  }
  if (phase === "placement_result" && placementResult !== null) {
    const progress =
      placement === null
        ? "Placement answer recorded."
        : `Placement answer ${Math.min(placement.answered + 1, placement.total)} of ${placement.total} recorded.`;
    const fallback =
      placementAssessmentDisposition === "abstained"
        ? " A source-backed multiple-choice fallback is ready."
        : "";
    return `${placementResultCopy(placementResult)} ${progress}${fallback}`;
  }
  if (phase === "placement_complete" && placement !== null) {
    return `${placementProgressLabel(placement)}. Your initial Knowledge Map is ready. Continue to the first lesson.`;
  }
  if (phase === "question") {
    return `${questionStage === "initial" ? "Quick check" : "New retry question"} loaded.`;
  }
  if (phase === "result" && assessment !== null) {
    const nextAction =
      disposition === "abstained"
        ? " A source-backed multiple-choice fallback is ready."
        : disposition === "correct"
          ? " Continue when ready."
          : " Review the feedback and choose the next action.";
    return `${assessment.learnerMessage}${nextAction}`;
  }
  if (phase === "lesson") return "The next source-backed lesson is ready.";
  if (phase === "summary")
    return "Session complete. Your Knowledge Map is up to date.";
  if (message !== "" && phase === "activation_failed") return "";
  return retryAnnouncement;
}

function FlowPlan({ view }: { readonly view: ConnectedStudyView }) {
  return (
    <div className="flow-plan">
      <div>
        <span>Today’s focus</span>
        <strong>{view.concept.conceptName}</strong>
      </div>
      <div>
        <span>{Math.round(Number(view.concept.mastery) * 100)}% mastery</span>
        <span>
          {view.concept.eligibleAttemptCount} assessed answer
          {view.concept.eligibleAttemptCount === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function LessonMedia({
  apiOrigin,
  lesson,
}: {
  readonly apiOrigin: string;
  readonly lesson: CourseStudyLesson;
}) {
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [refreshAttempted, setRefreshAttempted] = useState(false);
  const [refreshingPlayback, setRefreshingPlayback] = useState(false);
  const [refreshedDelivery, setRefreshedDelivery] =
    useState<PrivatePlaybackGrant | null>(null);
  const media =
    refreshedDelivery === null
      ? lesson.lesson.media
      : { delivery: refreshedDelivery, status: "ready" as const };
  const presentation = lessonMediaPresentation(
    lesson.lesson.assetId,
    lesson.lesson.modality,
    media,
  );
  const playable =
    presentation.state === "playable" && !playbackFailed && !refreshingPlayback;
  const unavailableMessage = refreshingPlayback
    ? `Refreshing ${presentation.kind === "audio" ? "audio" : "video"} playback…`
    : playbackFailed
      ? `${presentation.kind === "audio" ? "Audio" : "Video"} playback could not be loaded. The full lesson is available below.`
      : presentation.message;

  async function recoverPlayback() {
    setPlaybackFailed(true);
    if (
      refreshAttempted ||
      media?.delivery?.playback.refreshOnForbidden !== true
    ) {
      return;
    }
    setRefreshAttempted(true);
    setRefreshingPlayback(true);
    try {
      const response = await fetch(
        `${apiOrigin}/v1/assets/${encodeURIComponent(lesson.lesson.assetId)}/delivery`,
        { credentials: "include" },
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as {
        readonly delivery?: PrivatePlaybackGrant;
      };
      if (
        body.delivery === undefined ||
        lessonMediaPresentation(lesson.lesson.assetId, lesson.lesson.modality, {
          delivery: body.delivery,
          status: "ready",
        }).state !== "playable"
      ) {
        return;
      }
      setRefreshedDelivery(body.delivery);
      setPlaybackFailed(false);
    } catch {
      // The readable lesson remains available when grant refresh fails.
    } finally {
      setRefreshingPlayback(false);
    }
  }

  if (presentation.kind === "text") {
    return <div className="lesson-content">{lesson.content}</div>;
  }

  return (
    <div className="lesson-media">
      {playable && presentation.kind === "audio" ? (
        <audio
          aria-label={`${lesson.concept.conceptName} audio lesson`}
          controls
          onError={() => void recoverPlayback()}
          preload="metadata"
          src={presentation.url!}
        >
          Your browser does not support audio playback.
        </audio>
      ) : null}
      {playable && presentation.kind === "video" ? (
        <video
          aria-label={`${lesson.concept.conceptName} video lesson`}
          controls
          onError={() => void recoverPlayback()}
          preload="metadata"
          src={presentation.url!}
        >
          Your browser does not support video playback.
        </video>
      ) : null}
      {!playable ? (
        <div
          className={`lesson-media-state media-${refreshingPlayback ? "preparing" : presentation.state}`}
          role={
            presentation.state === "preparing" || refreshingPlayback
              ? "status"
              : "note"
          }
        >
          <span aria-hidden="true">
            {presentation.state === "preparing" || refreshingPlayback
              ? "◌"
              : "↳"}
          </span>
          <p>{unavailableMessage}</p>
        </div>
      ) : null}
      <details className="lesson-transcript" open={!playable}>
        <summary>{playable ? "Read transcript" : "Read lesson"}</summary>
        <div className="lesson-content">{lesson.content}</div>
      </details>
    </div>
  );
}

function FlowPlanFromLesson({
  lesson,
}: {
  readonly lesson: CourseStudyLesson;
}) {
  return (
    <div className="flow-plan">
      <div>
        <span>Today’s focus</span>
        <strong>{lesson.concept.conceptName}</strong>
      </div>
      <div>
        <span>
          {Math.round(Number(lesson.concept.mastery) * 100)}% current mastery
        </span>
        <span>About 10 minutes</span>
      </div>
    </div>
  );
}

function FlowBusy({ copy }: { readonly copy: string }) {
  return (
    <div className="flow-busy" role="status">
      <span className="loading-ring" />
      <p>{copy}</p>
    </div>
  );
}

function FlowNotice({
  actionDisabled = false,
  actionLabel = "Try again",
  copy,
  onRetry,
  title,
}: {
  readonly actionDisabled?: boolean;
  readonly actionLabel?: string;
  readonly copy: string;
  readonly onRetry: () => void;
  readonly title: string;
}) {
  return (
    <div className="flow-notice" role="alert">
      <strong>{title}</strong>
      <p>{copy}</p>
      <button disabled={actionDisabled} onClick={onRetry} type="button">
        {actionLabel}
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
  const response = await fetch(`${apiOrigin}/v1/preflight?capability=study`, {
    credentials: "include",
  });
  const body = (await response.json().catch(() => ({}))) as {
    readonly boundary?: ConnectedDemoPreflightView["boundary"];
    readonly checkedAt?: string;
    readonly contractVersion?: string;
    readonly dependencies?: readonly ConnectedDemoPreflightDependency[];
    readonly status?: "ready" | "unavailable";
  };
  if (
    (response.status !== 200 && response.status !== 503) ||
    body.dependencies === undefined ||
    body.boundary?.contractVersion !== "connected-demo-boundary-v1" ||
    body.boundary.destinationClass !== "staff-controlled-test" ||
    body.boundary.learnerClass !== "staff-controlled" ||
    body.boundary.sourceClass !== "human-approved-rights-cleared" ||
    body.checkedAt === undefined ||
    body.contractVersion !== "connected-demo-preflight-v1" ||
    body.status === undefined
  ) {
    throw new Error("Study availability could not be confirmed.");
  }
  return {
    boundary: body.boundary,
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
  additionalHeaders: Readonly<Record<string, string>> = {},
): Promise<Value> {
  const csrf = await requestJson<{ csrfToken: string }>(
    `${apiOrigin}/v1/csrf-token`,
  );
  const response = await fetch(`${apiOrigin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...additionalHeaders,
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
    return "Your session expired. Sign in again to continue.";
  }
  const assessmentCopy = assessmentRequestErrorCopy(code);
  if (assessmentCopy !== null) return assessmentCopy;
  switch (code) {
    case "grading_in_progress":
      return "This exact submission is still being graded. Try again shortly.";
    case "tutor_unavailable":
    case "service_unavailable":
      return "A learning service is temporarily unavailable. Your progress is unchanged.";
    case "retest_unavailable":
      return "A new follow-up question is not available yet.";
    case "regeneration_cooldown":
      return "A new lesson version was requested recently. Please wait a moment before trying again.";
    case "regeneration_not_allowed":
      return "This lesson is no longer eligible for regeneration. Refresh the course to see its latest state.";
    default:
      return "The request could not be completed. Please try again.";
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
  return `web/study/${kind}/v1/${sessionId}/${resourceId}/${hex}`;
}

async function tutorQuestionRequest(
  context: {
    readonly courseId: string;
    readonly sessionId: string;
    readonly sourceDocumentId: string;
  },
  question: string,
  contextQuestionId?: string,
): Promise<Readonly<Record<string, string>>> {
  const idempotencyValue =
    contextQuestionId === undefined
      ? question
      : `${contextQuestionId}\u0000${question}`;
  return {
    ...(contextQuestionId === undefined ? {} : { contextQuestionId }),
    courseId: context.courseId,
    idempotencyKey: await stableKey(
      "tutor-question",
      context.sessionId,
      context.courseId,
      idempotencyValue,
    ),
    question,
    sourceDocumentId: context.sourceDocumentId,
  };
}

function tutorCitationLabel(
  sectionPath: readonly string[],
  index: number,
): string {
  const label = sectionPath
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join(" › ");
  return label === "" ? `Course source ${index + 1}` : label;
}

function friendlyDependencyList(dependencies: readonly string[]): string {
  const labels = dependencies.map((dependency) => {
    switch (dependency) {
      case "model":
        return "personalized tutoring";
      case "postgres":
        return "saved progress";
      case "storage":
        return "course content";
      case "vector":
        return "course search";
      default:
        return dependency;
    }
  });
  if (labels.length === 0) {
    return "a learning service";
  }
  if (labels.length === 1) {
    return labels[0]!;
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
