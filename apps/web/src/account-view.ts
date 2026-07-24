import type {
  CourseConceptProgress,
  LibraryCourse,
  SessionHistoryItem,
} from "@reflo/accounts";

export interface ConceptProgressPresentation {
  readonly confidencePercent: number;
  readonly label: string;
  readonly masteryPercent: number | null;
  readonly tone: "developing" | "strong" | "unassessed" | "weak";
}

export function courseProgress(course: LibraryCourse): {
  readonly label: string;
  readonly percent: number;
  readonly tone: "active" | "danger" | "ready" | "waiting";
} {
  if (course.courseStatus === "failed" || course.sourceStatus === "failed") {
    return { label: "Needs attention", percent: 0, tone: "danger" };
  }
  if (course.sourceStatus === "ocr_required") {
    return { label: "OCR queued", percent: 10, tone: "waiting" };
  }
  if (course.courseStatus === "ready") {
    return { label: "Ready to study", percent: 100, tone: "ready" };
  }
  if (course.chapterCount === 0) {
    return {
      label: ingestionLabel(course.sourceStatus),
      percent: 18,
      tone: "waiting",
    };
  }
  const percent = Math.max(
    22,
    Math.round((course.chaptersReady / course.chapterCount) * 100),
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

export function fixedPercent(value: string): number {
  return Math.round(Number(value) * 100);
}

export function masteryDeltaLabel(value: string): string {
  const percent = Math.round(Number(value) * 100);
  return `${percent >= 0 ? "+" : ""}${percent} pts`;
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
