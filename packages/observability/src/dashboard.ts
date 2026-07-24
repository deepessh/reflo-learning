import type { DemoPipelineStage } from "./contracts.js";

export const SLS_DEMO_HEALTH_DASHBOARD_VERSION =
  "sls-demo-health-dashboard-v1" as const;

export interface SlsDemoHealthPanel {
  readonly description: string;
  readonly measures: readonly (
    | "failure_count"
    | "p95_duration_ms"
    | "replay_count"
    | "success_count"
    | "trace_count"
  )[];
  readonly query: string;
  readonly stage: DemoPipelineStage;
  readonly title: string;
  readonly traceFilter: string;
}

export const SLS_DEMO_HEALTH_DASHBOARD: {
  readonly honestLabel: string;
  readonly panels: readonly SlsDemoHealthPanel[];
  readonly version: typeof SLS_DEMO_HEALTH_DASHBOARD_VERSION;
} = Object.freeze({
  honestLabel:
    "Seeded/staff-controlled Demo Day operational health; not production privacy or pilot-readiness evidence",
  panels: [
    panel(
      "ingestion",
      "Demo ingestion health",
      "Source parsing and curriculum-structure availability for rights-cleared demo inputs.",
    ),
    panel(
      "generation",
      "Demo generation health",
      "Source-backed lesson, quiz, audio, video, and tutor model-route health.",
    ),
    panel(
      "grading",
      "Demo grading health",
      "Versioned short-answer model-route outcomes, validation, and latency.",
    ),
    panel(
      "test_delivery",
      "Staff-test delivery health",
      "Dedicated staff-controlled Telegram and email dispatch/response health.",
    ),
  ],
  version: SLS_DEMO_HEALTH_DASHBOARD_VERSION,
});

function panel(
  stage: DemoPipelineStage,
  title: string,
  description: string,
): SlsDemoHealthPanel {
  return Object.freeze({
    description,
    measures: [
      "trace_count",
      "success_count",
      "failure_count",
      "replay_count",
      "p95_duration_ms",
    ] as const,
    query: `${traceFilter(stage)} | SELECT count(1) AS trace_count, sum(CASE WHEN reflo_outcome = 'success' THEN 1 ELSE 0 END) AS success_count, sum(CASE WHEN reflo_outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count, sum(CASE WHEN reflo_outcome = 'replayed' THEN 1 ELSE 0 END) AS replay_count, approx_percentile(reflo_duration_ms, 0.95) AS p95_duration_ms`,
    stage,
    title,
    traceFilter: traceFilter(stage),
  });
}

function traceFilter(stage: DemoPipelineStage): string {
  return `reflo_schema_version:demo-operational-trace-v1 AND reflo_stage:${stage}`;
}
