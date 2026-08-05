import type { CourseProgress } from "@reflo/accounts";

export function chapterProgressPresentation(
  chapter: CourseProgress["chapters"][number],
): {
  readonly label: string;
  readonly tone: "attention" | "neutral" | "ready";
} {
  const dueCount = chapter.concepts.filter(
    (concept) => concept.review.state === "due",
  ).length;
  const assessedCount = chapter.concepts.filter(
    (concept) => concept.evidenceCount > 0,
  ).length;

  if (dueCount > 0) {
    return {
      label: dueCount === 1 ? "1 review due" : `${dueCount} reviews due`,
      tone: "attention",
    };
  }
  if (assessedCount === chapter.concepts.length && assessedCount > 0) {
    return { label: "Assessed", tone: "ready" };
  }
  if (assessedCount > 0) {
    return { label: "In progress", tone: "neutral" };
  }
  return { label: "Not started", tone: "neutral" };
}
