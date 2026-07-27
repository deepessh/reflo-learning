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

function exactPercent(value: string): string {
  const match = /^(-?)([01])\.(\d{5})$/.exec(value);
  if (match === null) {
    throw new Error("Exact mastery value is invalid");
  }
  const quanta = BigInt(match[2]!) * 100_000n + BigInt(match[3]!);
  const sign = match[1] === "-" && quanta !== 0n ? "-" : "";
  return `${sign}${quanta / 1_000n}.${String(quanta % 1_000n).padStart(3, "0")}`;
}
