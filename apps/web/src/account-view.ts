import type {
  CourseConceptProgress,
  ExamReadinessDisclosure,
  LibraryCourse,
  SessionHistoryItem,
} from "@reflo/accounts";

export interface ConceptProgressPresentation {
  readonly confidencePercent: number;
  readonly label: string;
  readonly masteryPercent: number | null;
  readonly tone: "developing" | "strong" | "unassessed" | "weak";
}

export interface ReadinessPresentation {
  readonly calibration: string;
  readonly copy: string;
  readonly label: string;
  readonly value: string;
}

export interface SessionSummaryPresentation {
  readonly detail: string;
  readonly reviewedConceptCount: number;
  readonly statusLabel: string;
  readonly successfulReviewCount: number;
}

export type CourseStudyAvailability =
  | { readonly kind: "available" }
  | {
      readonly copy: string;
      readonly kind: "failed" | "ocr_required" | "preparing";
      readonly title: string;
    };

export function courseStudyAvailability(
  course: LibraryCourse,
): CourseStudyAvailability {
  if (course.courseStatus === "failed" || course.sourceStatus === "failed") {
    const outlineMissing = course.chapterCount === 0;
    return {
      copy: outlineMissing
        ? "The course PDF stopped before a source-backed outline was ready. Reflo will not start a study session or record learning evidence from this unavailable course. Review course setup to validate the course PDF again."
        : "This course is marked as failed and cannot start a study session. Reflo will not record learning evidence from it. Review course setup before trying the course PDF again.",
      kind: "failed",
      title: outlineMissing
        ? "Course setup stopped before the outline was ready."
        : "Course preparation needs attention.",
    };
  }
  if (course.sourceStatus === "ocr_required") {
    return {
      copy: "Text recognition is required before this source can become a course. For this Demo Day surface, review course setup and choose the matching digitally generated course PDF.",
      kind: "ocr_required",
      title: "Text recognition is needed before study can begin.",
    };
  }
  if (
    course.sourceStatus === "parsed" &&
    (course.courseStatus === "generating" || course.courseStatus === "ready") &&
    course.chapterCount > 0
  ) {
    return { kind: "available" };
  }
  if (
    course.sourceStatus === "parsed" &&
    course.courseStatus === "ready" &&
    course.chapterCount === 0
  ) {
    return {
      copy: "This course has no usable source-backed outline, so Reflo will not start a study session or record learning evidence from it. Review course setup to validate the course PDF again.",
      kind: "failed",
      title: "A usable course outline is unavailable.",
    };
  }
  if (course.courseStatus === "archived") {
    return {
      copy: "This archived course is not available for study. Reflo will not start a session or record learning evidence from it.",
      kind: "failed",
      title: "This course is unavailable.",
    };
  }
  return {
    copy: "Source-backed chapters and concepts are still being prepared. Study will become available after the outline is ready. You can wait here or review course setup options.",
    kind: "preparing",
    title: "The course outline is still being prepared.",
  };
}

export function courseProgress(course: LibraryCourse): {
  readonly label: string;
  readonly percent: number | null;
  readonly tone: "active" | "danger" | "ready" | "waiting";
} {
  if (
    course.courseStatus === "failed" ||
    course.courseStatus === "archived" ||
    course.sourceStatus === "failed"
  ) {
    return { label: "Needs attention", percent: 0, tone: "danger" };
  }
  if (course.sourceStatus === "ocr_required") {
    return { label: "OCR queued", percent: null, tone: "waiting" };
  }
  if (course.sourceStatus !== "parsed") {
    return {
      label: ingestionLabel(course.sourceStatus),
      percent: null,
      tone: "waiting",
    };
  }
  if (course.courseStatus === "ready" && course.chapterCount === 0) {
    return { label: "Needs attention", percent: 0, tone: "danger" };
  }
  if (course.courseStatus === "ready") {
    return { label: "Ready to study", percent: 100, tone: "ready" };
  }
  if (course.chapterCount === 0) {
    return {
      label: ingestionLabel(course.sourceStatus),
      percent: null,
      tone: "waiting",
    };
  }
  const percent = Math.round(
    (course.chaptersReady / course.chapterCount) * 100,
  );
  return {
    label: `${course.chaptersReady} of ${course.chapterCount} chapters ready`,
    percent,
    tone: "active",
  };
}

export function sessionDuration(session: SessionHistoryItem): string {
  if (session.endedAt === null) {
    return "In progress";
  }
  const milliseconds =
    new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return `${minutes} min`;
}

export function sessionSummaryPresentation(
  session: SessionHistoryItem,
): SessionSummaryPresentation {
  const flowResults = objectValues(objectField(session.summary, "flowB"));
  const reviewedConceptCount =
    flowResults.length > 0
      ? flowResults.length
      : (nonNegativeIntegerField(session.summary, "conceptsReviewed") ?? 0);
  const successfulReviewCount = flowResults.filter((result) => {
    const outcome = stringField(result, "outcome");
    const delta = stringField(result, "masteryDelta");
    return outcome === "retest_succeeded" || Number(delta) > 0;
  }).length;

  if (session.status === "active") {
    return {
      detail: "Your completed activities and answers are saved.",
      reviewedConceptCount,
      statusLabel: "In progress",
      successfulReviewCount,
    };
  }
  if (session.status === "abandoned") {
    return {
      detail:
        reviewedConceptCount > 0
          ? conceptSummary(reviewedConceptCount, successfulReviewCount)
          : "This session ended before an activity was completed.",
      reviewedConceptCount,
      statusLabel: "Ended early",
      successfulReviewCount,
    };
  }
  return {
    detail:
      reviewedConceptCount > 0
        ? conceptSummary(reviewedConceptCount, successfulReviewCount)
        : "Your completed work is saved in this course.",
    reviewedConceptCount,
    statusLabel: "Completed",
    successfulReviewCount,
  };
}

export function conceptProgressPresentation(
  concept: CourseConceptProgress,
): ConceptProgressPresentation {
  if (concept.assessmentStatus === "unassessed" || concept.mastery === null) {
    return {
      confidencePercent: 0,
      label: "Unassessed",
      masteryPercent: null,
      tone: "unassessed",
    };
  }
  const masteryPercent = fixedPercent(concept.mastery);
  const confidencePercent = fixedPercent(concept.confidence);
  if (masteryPercent < 40) {
    return {
      confidencePercent,
      label: "Needs review",
      masteryPercent,
      tone: "weak",
    };
  }
  if (masteryPercent < 75) {
    return {
      confidencePercent,
      label: "Developing",
      masteryPercent,
      tone: "developing",
    };
  }
  return {
    confidencePercent,
    label: "Strong evidence",
    masteryPercent,
    tone: "strong",
  };
}

export function readinessPresentation(
  readiness: ExamReadinessDisclosure,
): ReadinessPresentation {
  const calibration =
    readiness.calibration.status === "unavailable"
      ? "Sample size: unavailable · error: unavailable"
      : `Sample size: ${readiness.calibration.sampleSize} · MAE: ${exactPercentLabel(
          readiness.calibration.meanAbsoluteError!,
        )}`;
  if (readiness.status === "eligible") {
    return {
      calibration,
      copy: readiness.experimental
        ? "Eligibility gates passed. This sprint policy score is experimental, not a certification prediction."
        : "Representative calibration meets the frozen threshold. This score is not a certification guarantee.",
      label: readiness.label,
      value: `${fixedPercent(readiness.score)}%`,
    };
  }
  const reasonCopy: Record<ExamReadinessDisclosure["reasons"][number], string> =
    {
      blueprint_missing: "No reviewed, versioned exam blueprint is connected.",
      evidence_coverage_insufficient:
        "Assessed mapping weight is below the 80% evidence minimum.",
      objective_evidence_missing:
        "At least one exam objective has no sufficiently assessed mapped concept.",
      objective_mapping_incomplete:
        "At least one exam objective has incomplete generation-current mappings.",
      reviewed_mappings_unavailable:
        "Reviewed, provenance-carrying concept mappings are unavailable.",
    };
  return {
    calibration,
    copy: readiness.reasons.map((reason) => reasonCopy[reason]).join(" "),
    label: "Exam Readiness",
    value: "Unavailable",
  };
}

export function fixedPercent(value: string): number {
  return Math.round(Number(value) * 100);
}

export function masteryDeltaLabel(value: string): string {
  const percent = exactPercent(value);
  return `${percent.startsWith("-") ? "" : "+"}${percent} pts`;
}

export function exactPercentLabel(value: string): string {
  return `${exactPercent(value)}%`;
}

function ingestionLabel(status: LibraryCourse["sourceStatus"]): string {
  switch (status) {
    case "quarantined":
    case "validating":
      return "Validating upload";
    case "queued":
      return "Waiting to process";
    case "parsing":
      return "Building outline";
    case "parsed":
      return "Generating chapters";
    case "ocr_required":
      return "OCR queued";
    case "failed":
      return "Needs attention";
  }
}

function conceptSummary(reviewed: number, successful: number): string {
  const reviewedCopy = `${reviewed} concept${reviewed === 1 ? "" : "s"} reviewed`;
  if (successful === 0) {
    return `${reviewedCopy}. Your next session will build on this work.`;
  }
  return `${reviewedCopy} · ${successful} strengthened after a follow-up check.`;
}

function objectField(
  value: Readonly<Record<string, unknown>> | null,
  name: string,
): Readonly<Record<string, unknown>> | null {
  const field = value?.[name];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? (field as Readonly<Record<string, unknown>>)
    : null;
}

function objectValues(
  value: Readonly<Record<string, unknown>> | null,
): readonly Readonly<Record<string, unknown>>[] {
  return value === null
    ? []
    : Object.values(value).filter(
        (entry): entry is Readonly<Record<string, unknown>> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      );
}

function nonNegativeIntegerField(
  value: Readonly<Record<string, unknown>> | null,
  name: string,
): number | null {
  const field = value?.[name];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : null;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const field = value[name];
  return typeof field === "string" ? field : null;
}

function exactPercent(value: string): string {
  const match = /^(-?)([01])\.(\d{5})$/.exec(value);
  if (match === null) {
    throw new Error("Exact mastery value is invalid");
  }
  const quanta = BigInt(match[2]!) * 100_000n + BigInt(match[3]!);
  const sign = match[1] === "-" && quanta !== 0n ? "-" : "";
  return `${sign}${quanta / 1_000n}.${String(quanta % 1_000n).padStart(3, "0")}`;
}
