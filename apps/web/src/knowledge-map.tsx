import type { CourseProgress } from "@reflo/accounts";

import {
  conceptProgressPresentation,
  fixedPercent,
  masteryDeltaLabel,
} from "./account-view";

export function KnowledgeMap({
  onRefresh,
  progress,
}: {
  readonly onRefresh: () => void;
  readonly progress: CourseProgress;
}) {
  const mastery = progress.mastery.value;
  return (
    <section
      className="panel knowledge-panel"
      aria-labelledby="knowledge-title"
    >
      <div className="knowledge-heading">
        <div>
          <p className="eyebrow">Live knowledge map</p>
          <h2 id="knowledge-title">{progress.title}</h2>
          <p>
            Mastery changes only when eligible assessment evidence is persisted.
            Lesson views and abstentions do not move this map.
          </p>
        </div>
        <div className="knowledge-refresh">
          <time dateTime={new Date(progress.generatedAt).toISOString()}>
            Updated {new Date(progress.generatedAt).toLocaleTimeString()}
          </time>
          <button
            className="secondary-button"
            onClick={onRefresh}
            type="button"
          >
            Refresh evidence
          </button>
        </div>
      </div>

      <div className="knowledge-summary">
        <article className="summary-card mastery-summary">
          <span>{progress.mastery.label}</span>
          <strong>
            {mastery === null ? "Evidence needed" : `${fixedPercent(mastery)}%`}
          </strong>
          <small>
            {progress.mastery.assessedConceptCount} of{" "}
            {progress.mastery.totalConceptCount} concepts assessed
          </small>
        </article>
        <article className="summary-card readiness-summary">
          <span>Exam Readiness</span>
          <strong>Unavailable</strong>
          <p>{readinessCopy(progress)}</p>
          <small>
            {progress.readiness.mappedConceptCount} mapped ·{" "}
            {progress.readiness.invalidatedConceptCount} invalidated ·{" "}
            {progress.readiness.unmappedConceptCount} unmapped
          </small>
        </article>
      </div>

      {progress.chapters.length === 0 ? (
        <div className="empty-state">
          <strong>Knowledge map is waiting for the outline</strong>
          <p>
            Concepts will appear here as the active curriculum is generated.
          </p>
        </div>
      ) : (
        <div className="chapter-map">
          {progress.chapters.map((chapter) => (
            <section className="chapter-row" key={chapter.chapterId}>
              <div className="chapter-label">
                <span>Chapter {chapter.order}</span>
                <h3>{chapter.title}</h3>
                <small>{chapter.concepts.length} concepts</small>
              </div>
              <div className="concept-grid">
                {chapter.concepts.map((concept) => {
                  const presentation = conceptProgressPresentation(concept);
                  return (
                    <article
                      className={`concept-tile tone-${presentation.tone}`}
                      key={concept.conceptId}
                    >
                      <div className="concept-heading">
                        <span>{presentation.label}</span>
                        <span className="mapping-badge">
                          {concept.mappingStatus}
                        </span>
                      </div>
                      <h4>{concept.name}</h4>
                      <div className="concept-measure">
                        <strong>
                          {presentation.masteryPercent === null
                            ? "—"
                            : `${presentation.masteryPercent}%`}
                        </strong>
                        <span>mastery estimate</span>
                      </div>
                      <div
                        aria-label={
                          presentation.masteryPercent === null
                            ? "No eligible mastery evidence"
                            : `${presentation.masteryPercent}% mastery estimate`
                        }
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={
                          presentation.masteryPercent === null
                            ? undefined
                            : presentation.masteryPercent
                        }
                        className="mastery-meter"
                        role="meter"
                      >
                        <span
                          style={{
                            width: `${presentation.masteryPercent ?? 0}%`,
                          }}
                        />
                      </div>
                      <div className="concept-meta">
                        <span>
                          Evidence strength {presentation.confidencePercent}%
                        </span>
                        <span>{reviewLabel(concept.review.state)}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="delta-section" aria-labelledby="delta-title">
        <div>
          <p className="eyebrow">Session evidence</p>
          <h3 id="delta-title">Recent mastery deltas</h3>
        </div>
        {progress.recentSessionDeltas.length === 0 ? (
          <p className="delta-empty">
            No completed re-teach loop has produced an eligible delta yet.
          </p>
        ) : (
          <ol className="delta-list">
            {progress.recentSessionDeltas.map((delta) => (
              <li key={`${delta.sessionId}-${delta.conceptId}`}>
                <div>
                  <strong>{delta.conceptName}</strong>
                  <small>
                    {delta.outcome === "retest_succeeded"
                      ? "Correct re-test evidence"
                      : "Gap scheduled for later review"}
                  </small>
                </div>
                <span>{masteryDeltaLabel(delta.masteryDelta)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function readinessCopy(progress: CourseProgress): string {
  return progress.readiness.targetBlueprintId === null
    ? "No reviewed, versioned exam blueprint is connected. This course is not presented as exam-calibrated."
    : "The target blueprint does not yet have reviewed versioned mappings, evidence coverage, and calibration evidence.";
}

function reviewLabel(state: "due" | "not_scheduled" | "scheduled"): string {
  switch (state) {
    case "due":
      return "Review due";
    case "scheduled":
      return "Review scheduled";
    case "not_scheduled":
      return "No review scheduled";
  }
}
