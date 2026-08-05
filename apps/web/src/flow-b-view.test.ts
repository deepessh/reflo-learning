import { describe, expect, it } from "vitest";

import {
  activationFailurePresentation,
  activationPlanDisposition,
  assessmentAvailabilityMessage,
  assessmentDisposition,
  assessmentRequestErrorCopy,
  completedSessionTransition,
  lessonMediaPresentation,
  studyErrorRetryTarget,
  studyRetryPresentation,
  shouldEnterPlacement,
  unavailableDependencyNames,
  type BrowserAssessmentResult,
} from "./flow-b-view";

describe("Flow B browser presentation", () => {
  it("shows a durable summary after session completion without reloading active state", () => {
    expect(completedSessionTransition("session_complete")).toEqual({
      loadActiveState: false,
      phase: "summary",
      refreshProgress: true,
    });
    expect(completedSessionTransition("review")).toBeNull();
  });

  it("recovers a generic submission error through persisted fallback state", () => {
    const genericError =
      "The request could not be completed. Please try again.";
    expect(genericError).toContain("Please try again");
    expect(
      studyErrorRetryTarget({
        courseLessonSessionId: null,
        submissionRetry: null,
        viewSessionId: "session-with-finalized-fallback",
      }),
    ).toEqual({
      kind: "persisted_state",
      sessionId: "session-with-finalized-fallback",
    });
  });

  it("reuses the exact submission when an in-memory retry is available", () => {
    expect(
      studyErrorRetryTarget({
        courseLessonSessionId: null,
        submissionRetry: "short_answer",
        viewSessionId: "session",
      }),
    ).toEqual({ kind: "short_answer" });
  });

  it("disables duplicate retry activation and announces pending recovery", () => {
    expect(studyRetryPresentation(true)).toEqual({
      actionDisabled: true,
      actionLabel: "Trying again…",
      announcement: "Retrying your saved activity…",
      ariaBusy: true,
    });
    expect(studyRetryPresentation(false)).toEqual({
      actionDisabled: false,
      actionLabel: "Try again",
      announcement: "",
      ariaBusy: false,
    });
  });

  it("does not reopen placement after the durable plan marks it complete", () => {
    expect(
      shouldEnterPlacement({
        placement: { answered: 10, status: "complete", total: 10 },
      }),
    ).toBe(false);
    expect(
      shouldEnterPlacement({
        placement: { answered: 4, status: "question", total: 10 },
      }),
    ).toBe(true);
    expect(shouldEnterPlacement({ demoFlowBPlacementComplete: true })).toBe(
      false,
    );
    expect(shouldEnterPlacement(undefined)).toBe(true);
  });

  it("explains replay-safe recovery after grading or projection failure", () => {
    expect(assessmentRequestErrorCopy("fallback_unavailable")).toContain(
      "answer was not submitted",
    );
    expect(
      assessmentRequestErrorCopy("assessment_projection_unavailable"),
    ).toContain("answer was saved");
    expect(assessmentRequestErrorCopy("assessment_unavailable")).toContain(
      "without creating a duplicate attempt",
    );
    expect(assessmentRequestErrorCopy("unrelated_error")).toBeNull();
  });

  it("never presents abstention as mastery evidence", () => {
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [
            {
              eligibleForMastery: false,
              rubricBand: "correct",
            },
          ],
          outcome: "abstained",
        }),
      ),
    ).toBe("abstained");
  });

  it("distinguishes failing and correct eligible evidence", () => {
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [
            {
              eligibleForMastery: true,
              rubricBand: "partially_correct",
            },
          ],
        }),
      ),
    ).toBe("failed");
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [{ eligibleForMastery: true, rubricBand: "correct" }],
        }),
      ),
    ).toBe("correct");
  });

  it("names only unavailable preflight dependencies", () => {
    expect(
      unavailableDependencyNames([
        { code: "available", name: "postgres" },
        { code: "unavailable", name: "model" },
        { code: "unavailable", name: "storage" },
      ]),
    ).toEqual(["model", "storage"]);
  });

  it("plays only a current owner-authorized grant for the requested asset", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const delivery = playbackGrant();
    expect(
      lessonMediaPresentation(
        "asset-a",
        "audio",
        { delivery, status: "ready" },
        now,
      ),
    ).toEqual({
      kind: "audio",
      message: null,
      state: "playable",
      url: "https://assets.reflo.example/private/audio.mp3?auth_key=opaque",
    });
    expect(
      lessonMediaPresentation(
        "asset-b",
        "audio",
        { delivery, status: "ready" },
        now,
      ).state,
    ).toBe("unavailable");
  });

  it("shows progressive and readable fallbacks for unfinished media", () => {
    expect(
      lessonMediaPresentation("asset-a", "audio", {
        delivery: null,
        status: "preparing",
      }),
    ).toMatchObject({
      state: "preparing",
      message: "Audio is still being prepared. You can read the lesson below.",
    });
    expect(
      lessonMediaPresentation("asset-a", "video", undefined),
    ).toMatchObject({
      state: "unavailable",
      message:
        "Video playback is unavailable right now. The full lesson is available below.",
    });
    expect(lessonMediaPresentation("asset-a", "text", undefined)).toEqual({
      kind: "text",
      message: null,
      state: "readable",
      url: null,
    });
  });

  it("sanitizes lesson-generation failures and retains valid update context", () => {
    const presentation = activationFailurePresentation({
      artifactKind: "first_text_lesson",
      attemptCount: 3,
      failureClass: "private_provider_trace_42",
      retryable: false,
      updatedAt: "2026-08-01T06:00:00.000Z",
    });
    expect(presentation.updatedAt).toBe("2026-08-01T06:00:00.000Z");
    expect(presentation.copy).not.toContain("private_provider_trace_42");
    expect(presentation.copy).not.toContain("Try again");
    expect(presentation.retryable).toBe(false);
    expect(presentation.guidance).toBe(
      "You can leave this page or return to your course library.",
    );
  });

  it("keeps a ready lesson readable while assessment availability differs", () => {
    expect(assessmentAvailabilityMessage("ready")).toBeNull();
    expect(assessmentAvailabilityMessage("pending")).toContain(
      "read this lesson now",
    );
    expect(assessmentAvailabilityMessage("failed")).toContain(
      "preparation failed",
    );
  });

  it("moves a refreshed preparation plan from pending to terminal failure", () => {
    expect(
      activationPlanDisposition({
        activationStatus: "lesson_pending",
        nextAction: "prepare_activation",
      }),
    ).toBe("pending");
    expect(
      activationPlanDisposition({
        activationFailure: {
          artifactKind: "first_text_lesson",
          attemptCount: 5,
          failureClass: "deadline_exceeded",
          retryable: false,
          updatedAt: "2026-08-01T07:00:00.000Z",
        },
        activationStatus: "lesson_failed",
        nextAction: "activation_failed",
      }),
    ).toBe("failed");
  });
});

function playbackGrant() {
  return {
    contractVersion: "private-delivery-v1" as const,
    expiresAt: "2026-07-31T12:15:00.000Z",
    metadata: {
      byteSize: 1024,
      contentType: "audio/mpeg",
      etag: "sha256:asset-a",
      resourceId: "asset-a",
      resourceKind: "asset" as const,
    },
    playback: {
      acceptsByteRanges: true as const,
      cacheControl: "private, no-store, max-age=0" as const,
      refreshOnForbidden: true as const,
      resumeSupported: true as const,
    },
    url: "https://assets.reflo.example/private/audio.mp3?auth_key=opaque",
  };
}

function resultFixture(
  overrides: Partial<BrowserAssessmentResult> = {},
): BrowserAssessmentResult {
  return {
    attemptId: "attempt",
    evidence: [],
    fallback: null,
    learnerMessage: "Recorded.",
    outcome: "graded",
    status: "created",
    ...overrides,
  };
}
