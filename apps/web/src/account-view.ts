import type { LibraryCourse, SessionHistoryItem } from "@reflo/accounts";

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
