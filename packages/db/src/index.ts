import pg, { type PoolClient } from "pg";

export { PostgresIngestionOperationStore } from "./ingestion-operation-store.js";
export type { PostgresIngestionOperationStoreOptions } from "./ingestion-operation-store.js";
export { PostgresAnalyticDbPool } from "./analyticdb-pool.js";
export { PostgresContentRepository } from "./content-repository.js";
export { PostgresDevelopmentSmokeRepository } from "./development-smoke-repository.js";
export type {
  DevelopmentSmokeArtifactEvidence,
  DevelopmentNarrationWrite,
  DevelopmentSmokeSeed,
  DevelopmentSmokeSnapshot,
} from "./development-smoke-repository.js";
export { PostgresActivationRepository } from "./activation-repository.js";
export { PostgresAudioGenerationRepository } from "./audio-generation-repository.js";
export type { PostgresAudioGenerationRepositoryOptions } from "./audio-generation-repository.js";
export { PostgresAssessmentRepository } from "./assessment-repository.js";
export { PostgresDemoDeliveryRepository } from "./delivery-repository.js";
export { PostgresTutorAgentRepository } from "./tutor-agent-repository.js";
export { PostgresConnectedDemoRepository } from "./connected-demo-repository.js";
export type { ConnectedDemoSessionSummary } from "./connected-demo-repository.js";
export type { ConnectedDemoSeedResult } from "./connected-demo-repository.js";
export { PostgresGateAttestationIndex } from "./gate-attestation-index.js";
export {
  KnowledgePersistenceError,
  PostgresKnowledgeRepository,
} from "./knowledge-repository.js";
export type {
  DeliveryOverrideProjection,
  KnowledgePersistenceErrorCode,
  LearningEventAppendResult,
} from "./knowledge-repository.js";

import type {
  AccountRepository,
  AuthenticatedAccount,
  CourseConceptProgress,
  CourseProgress,
  CourseSessionMasteryDelta,
  LibraryCourse,
  LoginTokenIssue,
  SessionHistoryItem,
  SessionIssue,
} from "@reflo/accounts";

const { Pool } = pg;

interface SessionRow extends Record<string, unknown> {
  absolute_expires_at: Date;
  authenticated_at: Date;
  idle_expires_at: Date;
  owner_scope_id: string;
  session_id: string;
  status: string;
  user_id: string;
}

interface ScopeRow extends Record<string, unknown> {
  owner_scope_id: string;
}

interface LibraryRow extends Record<string, unknown> {
  chapter_count: number;
  chapters_ready: number;
  course_id: string;
  course_status: LibraryCourse["courseStatus"];
  source_status: LibraryCourse["sourceStatus"];
  title: string;
  updated_at: Date;
}

interface HistoryRow extends Record<string, unknown> {
  course_id: string;
  course_title: string;
  ended_at: Date | null;
  session_id: string;
  started_at: Date;
  status: SessionHistoryItem["status"];
  summary: Record<string, unknown> | null;
}

interface ProgressCourseRow extends Record<string, unknown> {
  generated_at: Date;
  target_exam_blueprint_id: string | null;
  title: string;
}

interface ProgressConceptRow extends Record<string, unknown> {
  assessment_status: "assessed" | "unassessed" | null;
  chapter_id: string;
  chapter_order: number;
  chapter_title: string;
  concept_id: string;
  concept_name: string;
  concept_order: number | null;
  confidence: string | null;
  evidence_count: number | null;
  fsrs_due_at: Date | null;
  generation_version: string;
  last_reviewed_at: Date | null;
  mastery: string | null;
  next_delivery_at: Date | null;
}

interface ProgressSessionRow extends Record<string, unknown> {
  session_id: string;
  summary: Record<string, unknown> | null;
}

export class PostgresAccountRepository implements AccountRepository {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async reserveMagicLinkDelivery(
    now: Date,
    dailyLimit: number,
    totalLimit: number,
  ): Promise<boolean> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(214765003, 72026)");
      const counts = await client.query<{
        daily_count: number;
        total_count: number;
      }>(
        `SELECT count(*)::integer AS total_count,
                count(*) FILTER (
                  WHERE reserved_at > $1::timestamptz - interval '24 hours'
                    AND reserved_at <= $1::timestamptz
                )::integer AS daily_count
         FROM auth_email_delivery_reservation`,
        [now],
      );
      const row = requiredRow(counts.rows[0], "email delivery counts");
      if (row.daily_count >= dailyLimit || row.total_count >= totalLimit) {
        return false;
      }
      await client.query(
        "INSERT INTO auth_email_delivery_reservation (reserved_at) VALUES ($1)",
        [now],
      );
      return true;
    });
  }

  async issueLoginToken(issue: LoginTokenIssue): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
         VALUES ($1, decode($2, 'hex'), decode($3, 'base64'))
         ON CONFLICT (email_lookup_digest) DO NOTHING`,
        [issue.userId, issue.emailLookupDigest, issue.emailCiphertext],
      );
      const user = await client.query<{ id: string }>(
        `SELECT id
         FROM app_user
         WHERE email_lookup_digest = decode($1, 'hex')
         FOR UPDATE`,
        [issue.emailLookupDigest],
      );
      const userId = requiredRow(user.rows[0], "login identity").id;
      await client.query(
        `UPDATE auth_login_token
         SET invalidated_at = $1
         WHERE email_lookup_digest = decode($2, 'hex')
           AND purpose = 'login'
           AND consumed_at IS NULL
           AND invalidated_at IS NULL`,
        [issue.issuedAt, issue.emailLookupDigest],
      );
      await client.query(
        `INSERT INTO auth_login_token
           (id, user_id, email_lookup_digest, token_digest, purpose, issued_at, expires_at)
         VALUES ($1, $2, decode($3, 'hex'), decode($4, 'hex'), 'login', $5, $6)`,
        [
          issue.tokenId,
          userId,
          issue.emailLookupDigest,
          issue.tokenDigest,
          issue.issuedAt,
          issue.expiresAt,
        ],
      );
    });
  }

  async redeemLoginToken(
    tokenDigest: string,
    now: Date,
    session: SessionIssue,
  ): Promise<AuthenticatedAccount | null> {
    return this.#transaction(async (client) => {
      const token = await client.query<{ user_id: string }>(
        `SELECT user_id
         FROM auth_login_token
         WHERE token_digest = decode($1, 'hex')
           AND purpose = 'login'
           AND consumed_at IS NULL
           AND invalidated_at IS NULL
           AND expires_at > $2
         FOR UPDATE`,
        [tokenDigest, now],
      );
      if (token.rows[0] === undefined) {
        return null;
      }
      const userId = token.rows[0].user_id;
      await client.query(
        `UPDATE auth_login_token
         SET consumed_at = CASE WHEN token_digest = decode($1, 'hex') THEN $2 ELSE consumed_at END,
             invalidated_at = CASE WHEN token_digest <> decode($1, 'hex') THEN $2 ELSE invalidated_at END
         WHERE user_id = $3
           AND purpose = 'login'
           AND consumed_at IS NULL
           AND invalidated_at IS NULL`,
        [tokenDigest, now, userId],
      );
      const user = await client.query<{ status: string }>(
        "SELECT status FROM app_user WHERE id = $1 FOR UPDATE",
        [userId],
      );
      if (user.rows[0]?.status !== "active") {
        return null;
      }

      const scope = await client.query<ScopeRow>(
        `SELECT reflo_bootstrap_personal_scope($1, $2, $3) AS owner_scope_id`,
        [session.ownerScopeId, session.membershipId, userId],
      );
      const ownerScopeId = requiredRow(
        scope.rows[0],
        "personal scope",
      ).owner_scope_id;
      await client.query(
        `INSERT INTO auth_session
           (id, user_id, owner_scope_id, session_digest, authenticated_at,
            created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $5, $5, $6, $7)`,
        [
          session.sessionId,
          userId,
          ownerScopeId,
          session.sessionDigest,
          session.authenticatedAt,
          session.idleExpiresAt,
          session.absoluteExpiresAt,
        ],
      );
      return {
        absoluteExpiresAt: session.absoluteExpiresAt,
        authenticatedAt: session.authenticatedAt,
        idleExpiresAt: session.idleExpiresAt,
        ownerScopeId,
        sessionId: session.sessionId,
        userId,
      };
    });
  }

  async authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedAccount | null> {
    return this.#transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `SELECT session.id AS session_id, session.user_id, session.owner_scope_id,
                session.authenticated_at, session.idle_expires_at,
                session.absolute_expires_at, app_user.status
         FROM auth_session AS session
         JOIN app_user ON app_user.id = session.user_id
         WHERE session.session_digest = decode($1, 'hex')
           AND session.revoked_at IS NULL
         FOR UPDATE OF session`,
        [sessionDigest],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      if (
        row.status !== "active" ||
        row.idle_expires_at <= now ||
        row.absolute_expires_at <= now
      ) {
        await client.query(
          "UPDATE auth_session SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2",
          [now, row.session_id],
        );
        return null;
      }

      await setScopeContext(client, row.user_id, row.owner_scope_id);
      const membership = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM scope_membership
           WHERE owner_scope_id = $1 AND user_id = $2 AND revoked_at IS NULL
         ) AS present`,
        [row.owner_scope_id, row.user_id],
      );
      if (membership.rows[0]?.present !== true) {
        await client.query(
          "UPDATE auth_session SET revoked_at = $1 WHERE id = $2",
          [now, row.session_id],
        );
        return null;
      }
      const idleExpiresAt = new Date(
        Math.min(
          row.absolute_expires_at.getTime(),
          now.getTime() + 7 * 24 * 60 * 60 * 1_000,
        ),
      );
      await client.query(
        `UPDATE auth_session
         SET last_seen_at = $1, idle_expires_at = $2
         WHERE id = $3`,
        [now, idleExpiresAt, row.session_id],
      );
      return {
        absoluteExpiresAt: row.absolute_expires_at,
        authenticatedAt: row.authenticated_at,
        idleExpiresAt,
        ownerScopeId: row.owner_scope_id,
        sessionId: row.session_id,
        userId: row.user_id,
      };
    });
  }

  async revokeSession(sessionDigest: string, now: Date): Promise<void> {
    await this.#pool.connect().then(async (client) => {
      try {
        await client.query(
          `UPDATE auth_session
           SET revoked_at = COALESCE(revoked_at, $1)
           WHERE session_digest = decode($2, 'hex')`,
          [now, sessionDigest],
        );
      } finally {
        client.release();
      }
    });
  }

  async beginDeletion(userId: string, now: Date): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `UPDATE app_user
         SET status = 'deletion_pending', updated_at = $1
         WHERE id = $2 AND status = 'active'`,
        [now, userId],
      );
      await client.query(
        `UPDATE auth_session
         SET revoked_at = COALESCE(revoked_at, $1)
         WHERE user_id = $2`,
        [now, userId],
      );
    });
  }

  async listLibrary(
    account: AuthenticatedAccount,
  ): Promise<readonly LibraryCourse[]> {
    return this.#scopedRead(account, async (client) => {
      const result = await client.query<LibraryRow>(
        `SELECT course.id AS course_id, course.title,
                course.status AS course_status,
                source_document.parse_status AS source_status,
                count(chapter.id)::integer AS chapter_count,
                count(chapter.id) FILTER (WHERE chapter.generation_status = 'ready')::integer AS chapters_ready,
                course.updated_at
         FROM course
         JOIN source_document
           ON source_document.owner_scope_id = course.owner_scope_id
          AND source_document.id = course.source_document_id
         LEFT JOIN chapter
           ON chapter.owner_scope_id = course.owner_scope_id
          AND chapter.course_id = course.id
          AND (
            chapter.curriculum_generation_id = course.active_curriculum_generation_id
            OR (
              chapter.curriculum_generation_id IS NULL
              AND course.active_curriculum_generation_id IS NULL
            )
          )
         WHERE course.owner_scope_id = $1
           AND course.status <> 'archived'
         GROUP BY course.id, source_document.parse_status
         ORDER BY course.updated_at DESC, course.id`,
        [account.ownerScopeId],
      );
      return result.rows.map((row) => ({
        chapterCount: row.chapter_count,
        chaptersReady: row.chapters_ready,
        courseId: row.course_id,
        courseStatus: row.course_status,
        sourceStatus: row.source_status,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    });
  }

  async getCourseProgress(
    account: AuthenticatedAccount,
    courseId: string,
  ): Promise<CourseProgress | null> {
    return this.#scopedRead(account, async (client) => {
      const courseResult = await client.query<ProgressCourseRow>(
        `SELECT course.title, course.target_exam_blueprint_id,
                transaction_timestamp() AS generated_at
         FROM course
         WHERE course.owner_scope_id = $1
           AND course.id = $2
           AND course.status <> 'archived'`,
        [account.ownerScopeId, courseId],
      );
      const course = courseResult.rows[0];
      if (course === undefined) {
        return null;
      }

      const conceptResult = await client.query<ProgressConceptRow>(
        `SELECT chapter.id AS chapter_id, chapter.chapter_order,
                chapter.title AS chapter_title, concept.id AS concept_id,
                concept.name AS concept_name, concept.concept_order,
                concept.generation_version, state.mastery::text,
                state.confidence::text, state.evidence_count,
                state.assessment_status, state.last_reviewed_at,
                schedule.fsrs_due_at, schedule.next_delivery_at
         FROM course
         JOIN chapter
           ON chapter.owner_scope_id = course.owner_scope_id
          AND chapter.course_id = course.id
          AND (
            chapter.curriculum_generation_id = course.active_curriculum_generation_id
            OR (
              chapter.curriculum_generation_id IS NULL
              AND course.active_curriculum_generation_id IS NULL
            )
          )
         JOIN concept
           ON concept.owner_scope_id = chapter.owner_scope_id
          AND concept.chapter_id = chapter.id
          AND (
            concept.curriculum_generation_id = course.active_curriculum_generation_id
            OR (
              concept.curriculum_generation_id IS NULL
              AND course.active_curriculum_generation_id IS NULL
            )
          )
         LEFT JOIN knowledge_state AS state
           ON state.owner_scope_id = concept.owner_scope_id
          AND state.user_id = $3
          AND state.concept_id = concept.id
         LEFT JOIN review_schedule AS schedule
           ON schedule.owner_scope_id = concept.owner_scope_id
          AND schedule.user_id = $3
          AND schedule.concept_id = concept.id
          AND schedule.fsrs_profile_id = 'fsrs-profile-v1'
         WHERE course.owner_scope_id = $1 AND course.id = $2
         ORDER BY chapter.chapter_order, chapter.id,
                  concept.concept_order NULLS LAST, concept.id`,
        [account.ownerScopeId, courseId, account.userId],
      );
      const concepts = conceptResult.rows.map((row) =>
        projectConceptProgress(row, course.generated_at),
      );
      const conceptNames = new Map(
        concepts.map((concept) => [concept.conceptId, concept.name]),
      );
      const sessionResult = await client.query<ProgressSessionRow>(
        `SELECT study_session.id AS session_id, study_session.summary
         FROM study_session
         WHERE study_session.owner_scope_id = $1
           AND study_session.user_id = $2
           AND study_session.course_id = $3
           AND study_session.summary ? 'flowB'
         ORDER BY study_session.started_at DESC, study_session.id
         LIMIT 20`,
        [account.ownerScopeId, account.userId, courseId],
      );
      const recentSessionDeltas = sessionResult.rows
        .flatMap((row) => projectSessionDeltas(row, conceptNames))
        .sort(
          (left, right) =>
            right.completedAt.getTime() - left.completedAt.getTime() ||
            compareAscii(left.sessionId, right.sessionId) ||
            compareAscii(left.conceptId, right.conceptId),
        )
        .slice(0, 10);
      const assessed = concepts.filter(
        (concept) =>
          concept.assessmentStatus === "assessed" && concept.mastery !== null,
      );
      const targetBlueprintId = course.target_exam_blueprint_id;

      return {
        chapters: groupConceptsByChapter(conceptResult.rows, concepts),
        courseId,
        generatedAt: course.generated_at,
        mastery: {
          assessedConceptCount: assessed.length,
          kind: "course_mastery_estimate",
          label: "Course Mastery Estimate",
          totalConceptCount: concepts.length,
          value: averageFixed(assessed.map((concept) => concept.mastery!)),
        },
        readiness: {
          blueprintVersion: null,
          invalidatedConceptCount: 0,
          mappedConceptCount: 0,
          reasons:
            targetBlueprintId === null
              ? [
                  "blueprint_missing",
                  "evidence_minimum_not_met",
                  "calibration_unavailable",
                ]
              : [
                  "reviewed_mappings_unavailable",
                  "evidence_minimum_not_met",
                  "calibration_unavailable",
                ],
          score: null,
          status: "unavailable",
          targetBlueprintId,
          unmappedConceptCount: concepts.length,
        },
        recentSessionDeltas,
        title: course.title,
      };
    });
  }

  async listSessionHistory(
    account: AuthenticatedAccount,
  ): Promise<readonly SessionHistoryItem[]> {
    return this.#scopedRead(account, async (client) => {
      const result = await client.query<HistoryRow>(
        `SELECT study_session.id AS session_id, study_session.course_id,
                course.title AS course_title, study_session.status,
                study_session.started_at, study_session.ended_at,
                study_session.summary
         FROM study_session
         JOIN course
           ON course.owner_scope_id = study_session.owner_scope_id
          AND course.id = study_session.course_id
         WHERE study_session.owner_scope_id = $1
           AND study_session.user_id = $2
         ORDER BY study_session.started_at DESC, study_session.id
         LIMIT 100`,
        [account.ownerScopeId, account.userId],
      );
      return result.rows.map((row) => ({
        courseId: row.course_id,
        courseTitle: row.course_title,
        endedAt: row.ended_at,
        sessionId: row.session_id,
        startedAt: row.started_at,
        status: row.status,
        summary: row.summary,
      }));
    });
  }

  async #scopedRead<Result>(
    account: AuthenticatedAccount,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, account.userId, account.ownerScopeId);
      return operation(client);
    });
  }

  async #transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function projectConceptProgress(
  row: ProgressConceptRow,
  generatedAt: Date,
): CourseConceptProgress {
  const assessed = row.assessment_status === "assessed";
  const nextDeliveryAt = assessed ? row.next_delivery_at : null;
  return {
    assessmentStatus: assessed ? "assessed" : "unassessed",
    conceptId: row.concept_id,
    confidence: assessed ? (row.confidence ?? "0.00000") : "0.00000",
    evidenceCount: assessed ? (row.evidence_count ?? 0) : 0,
    generationVersion: row.generation_version,
    lastReviewedAt: assessed ? row.last_reviewed_at : null,
    mappingStatus: "unmapped",
    mastery: assessed ? row.mastery : null,
    name: row.concept_name,
    order: row.concept_order ?? 0,
    review: {
      fsrsDueAt: assessed ? row.fsrs_due_at : null,
      nextDeliveryAt,
      state:
        nextDeliveryAt === null
          ? "not_scheduled"
          : nextDeliveryAt <= generatedAt
            ? "due"
            : "scheduled",
    },
  };
}

function groupConceptsByChapter(
  rows: readonly ProgressConceptRow[],
  concepts: readonly CourseConceptProgress[],
): CourseProgress["chapters"] {
  const chapters = new Map<
    string,
    {
      chapterId: string;
      concepts: CourseConceptProgress[];
      order: number;
      title: string;
    }
  >();
  for (const [index, row] of rows.entries()) {
    const chapter = chapters.get(row.chapter_id) ?? {
      chapterId: row.chapter_id,
      concepts: [],
      order: row.chapter_order,
      title: row.chapter_title,
    };
    chapter.concepts.push(concepts[index]!);
    chapters.set(row.chapter_id, chapter);
  }
  return [...chapters.values()];
}

function projectSessionDeltas(
  row: ProgressSessionRow,
  conceptNames: ReadonlyMap<string, string>,
): readonly CourseSessionMasteryDelta[] {
  const flowB = objectField(row.summary, "flowB");
  if (flowB === null) {
    return [];
  }
  const deltas: CourseSessionMasteryDelta[] = [];
  for (const [conceptId, candidate] of Object.entries(flowB)) {
    const value = asObject(candidate);
    const conceptName = conceptNames.get(conceptId);
    if (value === null || conceptName === undefined) {
      continue;
    }
    const completedAt = dateField(value, "completedAt");
    const finalMastery = fixedField(value, "finalMastery");
    const initialMastery = fixedField(value, "initialMastery");
    const masteryDelta = deltaField(value, "masteryDelta");
    const outcome = value.outcome;
    if (
      completedAt === null ||
      finalMastery === null ||
      initialMastery === null ||
      masteryDelta === null ||
      (outcome !== "retest_succeeded" &&
        outcome !== "stopped_after_two_replacements")
    ) {
      continue;
    }
    deltas.push({
      completedAt,
      conceptId,
      conceptName,
      finalMastery,
      initialMastery,
      masteryDelta,
      outcome,
      sessionId: row.session_id,
    });
  }
  return deltas;
}

function averageFixed(values: readonly string[]): string | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + fixedUnits(value), 0n);
  const denominator = BigInt(values.length);
  let average = total / denominator;
  if ((total % denominator) * 2n >= denominator) {
    average += 1n;
  }
  return formatFixed(average);
}

function fixedUnits(value: string): bigint {
  const match = /^(0|1)\.(\d{5})$/.exec(value);
  if (match === null) {
    throw new Error("Database returned invalid fixed-point mastery");
  }
  return BigInt(match[1]!) * 100_000n + BigInt(match[2]!);
}

function formatFixed(value: bigint): string {
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, -5)}.${digits.slice(-5)}`;
}

function objectField(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return value === null ? null : asObject(value[key]);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dateField(value: Record<string, unknown>, key: string): Date | null {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    return null;
  }
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function fixedField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === "string" &&
    /^(?:0\.\d{5}|1\.00000)$/.test(candidate)
    ? candidate
    : null;
}

function deltaField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === "string" &&
    /^-?(?:0\.\d{5}|1\.00000)$/.test(candidate)
    ? candidate
    : null;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function setScopeContext(
  client: PoolClient,
  userId: string,
  ownerScopeId: string,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [userId]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    ownerScopeId,
  ]);
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (row === undefined) {
    throw new Error(`Database did not return required ${label}`);
  }
  return row;
}
