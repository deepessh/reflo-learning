import type { CourseProgress } from "@reflo/accounts";

import {
  conceptProgressPresentation,
  fixedPercent,
  masteryDeltaLabel,
  readinessPresentation,
} from "./account-view";
import { chapterProgressPresentation } from "./knowledge-map-view";

export function KnowledgeMap({
  onRefresh,
  progress,
}: {
  readonly onRefresh: () => void;
  readonly progress: CourseProgress;
}) {
  const mastery = progress.mastery.value;
  const readiness = readinessPresentation(progress.readiness);
  return (
    <section
      className="panel knowledge-panel"
      aria-labelledby="knowledge-title"
    >
      <div className="knowledge-heading">
        <div>
          <p className="eyebrow">Knowledge Map</p>
          <h2 id="knowledge-title">{progress.title}</h2>
          <p>See what is strong, what needs review, and where to focus next.</p>
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
            Refresh
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
        {progress.readiness.status === "eligible" ? (
          <article className="summary-card readiness-summary">
            <span>{readiness.label}</span>
            <strong>{readiness.value}</strong>
            <p>{readiness.copy}</p>
            <details className="readiness-details">
              <summary>How this score is measured</summary>
              <p>{readiness.calibration}</p>
              <small>
                {progress.readiness.mappedConceptCount} mapped ·{" "}
                {fixedPercent(progress.readiness.evidenceCoverage)}% evidence
              </small>
            </details>
          </article>
        ) : null}
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
          {progress.chapters.map((chapter, chapterIndex) => {
            const chapterPresentation = chapterProgressPresentation(chapter);
            return (
              <details
                className="chapter-row"
                key={chapter.chapterId}
                open={chapterIndex === 0}
              >
                <summary className="chapter-label">
                  <span className="chapter-title-group">
                    <span>Chapter {chapter.order}</span>
                    <strong>{chapter.title}</strong>
                  </span>
                  <span className="chapter-overview">
                    <span className="chapter-concept-count">
                      <strong>{chapter.concepts.length}</strong>
                      <span>
                        {chapter.concepts.length === 1 ? "concept" : "concepts"}
                      </span>
                    </span>
                    <span
                      className={`chapter-status tone-${chapterPresentation.tone}`}
                    >
                      {chapterPresentation.label}
                    </span>
                    <span className="chapter-toggle" aria-hidden="true">
                      <span className="chapter-toggle-show">Show concepts</span>
                      <span className="chapter-toggle-hide">Hide concepts</span>
                      <span className="chapter-toggle-icon">↓</span>
                    </span>
                  </span>
                </summary>
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
                        <span>{reviewLabel(concept.review.state)}</span>
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
                        <span>{concept.evidenceCount} assessed answers</span>
                        {concept.lastReviewedAt === null ? null : (
                          <span>
                            Reviewed{" "}
                            {new Date(
                              concept.lastReviewedAt,
                            ).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <section className="delta-section" aria-labelledby="delta-title">
        <div>
          <p className="eyebrow">Recent sessions</p>
          <h3 id="delta-title">Progress changes</h3>
        </div>
        {progress.recentSessionDeltas.length === 0 ? (
          <p className="delta-empty">
            Complete a study session to see how your mastery changes.
          </p>
        ) : (
          <ol className="delta-list">
            {progress.recentSessionDeltas.map((delta) => (
              <li key={`${delta.sessionId}-${delta.conceptId}`}>
                <div>
                  <strong>{delta.conceptName}</strong>
                  <small>
                    {delta.outcome === "retest_succeeded"
                      ? "Improved after a follow-up question"
                      : "Scheduled for another review"}
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
