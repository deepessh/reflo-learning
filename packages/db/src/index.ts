import pg, { type PoolClient } from "pg";

export { PostgresIngestionOperationStore } from "./ingestion-operation-store.js";
export type { PostgresIngestionOperationStoreOptions } from "./ingestion-operation-store.js";

import type {
  AccountRepository,
  AuthenticatedAccount,
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
