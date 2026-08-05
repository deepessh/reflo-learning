import { createHash } from "node:crypto";

import type {
  DeliveryAnswerFinalization,
  DeliveryAnswerInput,
  DeliveryPreferenceSettings,
  DemoDeliveryDestination,
  DemoDeliveryRepository,
  EmailQuizPreview,
  ReservedDelivery,
  ReservedDeliveryItem,
} from "@reflo/delivery";
import { DeliveryError } from "@reflo/delivery";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  type KnowledgeAuthorizationContext,
} from "@reflo/knowledge-model";
import { canonicalJson, stableUuid } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface DeliveryRow extends Record<string, unknown> {
  attempt_count: number;
  email_token_digest: string | null;
  email_token_expires_at: Date | null;
  email_token_redeemed_at: Date | null;
  expires_at: Date;
  id: string;
  idempotency_key: string;
  provider: "email" | "telegram";
  provider_message_id: string | null;
  request_digest: string;
  status: ReservedDelivery["status"];
}

interface DeliveryItemRow extends Record<string, unknown> {
  chosen_local_time: string;
  concept_id: string;
  delivery_item_id: string;
  keyed_answer: string;
  prompt: string;
  quiz_item_id: string;
  quiz_item_version: string;
  response_options: unknown;
  review_schedule_id: string;
  time_zone: string;
}

interface SubmissionRow extends Record<string, unknown> {
  request_digest: string;
}

interface AttemptReplayRow extends DeliveryItemRow {
  answer: Record<string, unknown>;
  attempt_id: string;
}

interface StreakRow extends Record<string, unknown> {
  current_streak: number;
  last_answered_on: string;
  longest_streak: number;
}

interface PreferenceRow extends Record<string, unknown> {
  chosen_local_time: string;
  provider: DeliveryPreferenceSettings["provider"];
  time_zone: string;
}

export class PostgresDemoDeliveryRepository implements DemoDeliveryRepository {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new DeliveryError("invalid_configuration");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async loadPreference(
    authorization: KnowledgeAuthorizationContext,
  ): Promise<DeliveryPreferenceSettings | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<PreferenceRow>(
        `SELECT provider, chosen_local_time::text, time_zone
         FROM delivery_preference
         WHERE owner_scope_id = $1 AND user_id = $2`,
        [authorization.ownerScopeId, authorization.actorId],
      );
      return materializePreference(result.rows[0]);
    });
  }

  async savePreference(
    authorization: KnowledgeAuthorizationContext,
    preference: DeliveryPreferenceSettings,
  ): Promise<DeliveryPreferenceSettings> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<PreferenceRow>(
        `INSERT INTO delivery_preference
           (owner_scope_id, user_id, provider, chosen_local_time, time_zone)
         VALUES ($1, $2, $3, $4::time, $5)
         ON CONFLICT (owner_scope_id, user_id) DO UPDATE
         SET provider = EXCLUDED.provider,
             chosen_local_time = EXCLUDED.chosen_local_time,
             time_zone = EXCLUDED.time_zone,
             updated_at = now()
         RETURNING provider, chosen_local_time::text, time_zone`,
        [
          authorization.ownerScopeId,
          authorization.actorId,
          preference.provider,
          preference.chosenLocalTime,
          preference.timeZone,
        ],
      );
      return required(materializePreference(result.rows[0]));
    });
  }

  async reserveDueBatch(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly expiresAt: string;
      readonly idempotencyKey: string;
      readonly now: string;
    },
  ): Promise<ReservedDelivery | null> {
    assertAuthorization(authorization, destination);
    const requestDigest = sha256(
      canonicalJson({
        channelIdentityId: destination.channelIdentityId,
        ownerScopeId: authorization.ownerScopeId,
        provider: destination.provider,
        userId: authorization.actorId,
        version: "demo-delivery-v1",
      }),
    );
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await advisoryLock(
        client,
        `${authorization.ownerScopeId}/${authorization.actorId}/${destination.provider}`,
      );
      await assertDestination(client, destination);

      const existing = await loadDeliveryByIdempotency(
        client,
        authorization.ownerScopeId,
        destination.provider,
        request.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.request_digest !== requestDigest) {
          throw new DeliveryError("conflicting_duplicate");
        }
        return materializeDelivery(
          client,
          authorization.ownerScopeId,
          existing,
        );
      }

      const due = await client.query<DeliveryItemRow>(
        `SELECT schedule.id AS review_schedule_id,
                schedule.time_zone,
                schedule.chosen_local_time::text,
                concept.id AS concept_id,
                question.id AS quiz_item_id,
                question.prompt,
                question.keyed_answer #>> '{}' AS keyed_answer,
                question.response_options,
                question.version AS quiz_item_version,
                ''::text AS delivery_item_id
         FROM review_schedule AS schedule
         JOIN concept
           ON concept.owner_scope_id = schedule.owner_scope_id
          AND concept.id = schedule.concept_id
         JOIN chapter
           ON chapter.owner_scope_id = concept.owner_scope_id
          AND chapter.id = concept.chapter_id
         JOIN LATERAL (
           SELECT item.*
           FROM quiz_item_concept AS link
           JOIN quiz_item AS item
             ON item.owner_scope_id = link.owner_scope_id
            AND item.id = link.quiz_item_id
           WHERE link.owner_scope_id = schedule.owner_scope_id
             AND link.concept_id = schedule.concept_id
             AND item.course_id = chapter.course_id
             AND item.item_type = 'multiple_choice'
             AND item.response_options IS NOT NULL
             AND (
               SELECT count(*)
               FROM quiz_item_concept AS all_links
               WHERE all_links.owner_scope_id = item.owner_scope_id
                 AND all_links.quiz_item_id = item.id
             ) = 1
           ORDER BY item.difficulty, item.id
           LIMIT 1
         ) AS question ON true
         WHERE schedule.owner_scope_id = $1
           AND schedule.user_id = $2
           AND schedule.next_delivery_at <= $3::timestamptz
           AND NOT EXISTS (
             SELECT 1
             FROM delivery_item AS prior_item
             JOIN quiz_delivery AS prior_delivery
               ON prior_delivery.owner_scope_id = prior_item.owner_scope_id
              AND prior_delivery.id = prior_item.delivery_id
             WHERE prior_item.owner_scope_id = schedule.owner_scope_id
               AND prior_item.review_schedule_id = schedule.id
               AND prior_delivery.status IN (
                 'pending', 'processing', 'submitted'
               )
               AND prior_delivery.expires_at > $3::timestamptz
           )
         ORDER BY schedule.next_delivery_at, schedule.id
         LIMIT 3
         FOR UPDATE OF schedule SKIP LOCKED`,
        [authorization.ownerScopeId, authorization.actorId, request.now],
      );
      if (due.rows.length === 0) {
        return null;
      }
      const deliveryId = stableUuid({
        idempotencyKey: request.idempotencyKey,
        ownerScopeId: authorization.ownerScopeId,
        provider: destination.provider,
      });
      await client.query(
        `INSERT INTO quiz_delivery
           (id, owner_scope_id, channel_identity_id, provider,
            idempotency_key, request_digest, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::timestamptz)`,
        [
          deliveryId,
          authorization.ownerScopeId,
          destination.channelIdentityId,
          destination.provider,
          request.idempotencyKey,
          requestDigest,
          request.expiresAt,
        ],
      );
      for (const [index, row] of due.rows.entries()) {
        const itemId = stableUuid({
          deliveryId,
          reviewScheduleId: row.review_schedule_id,
        });
        await client.query(
          `INSERT INTO delivery_item
             (id, owner_scope_id, delivery_id, review_schedule_id,
              quiz_item_id, item_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            itemId,
            authorization.ownerScopeId,
            deliveryId,
            row.review_schedule_id,
            row.quiz_item_id,
            index + 1,
          ],
        );
      }
      const created = await loadDeliveryById(
        client,
        authorization.ownerScopeId,
        deliveryId,
      );
      return materializeDelivery(
        client,
        authorization.ownerScopeId,
        required(created),
      );
    });
  }

  async bindEmailToken(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    expiresAt: string,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query(
        `UPDATE quiz_delivery
         SET email_token_digest = $3,
             email_token_expires_at = $4::timestamptz,
             updated_at = now()
         WHERE owner_scope_id = $1
           AND id = $2
           AND provider = 'email'
           AND expires_at = $4::timestamptz
           AND (
             email_token_digest IS NULL
             OR email_token_digest = $3
           )`,
        [authorization.ownerScopeId, deliveryId, tokenDigest, expiresAt],
      );
      if (result.rowCount !== 1) {
        throw new DeliveryError("conflicting_duplicate");
      }
    });
  }

  async markSubmitted(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    providerMessageId: string,
  ): Promise<ReservedDelivery> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query(
        `UPDATE quiz_delivery
         SET status = 'submitted',
             provider_message_id = $4,
             attempt_count = attempt_count + 1,
             claim_token = NULL,
             lease_expires_at = NULL,
             sanitized_error = NULL,
             updated_at = now()
         WHERE owner_scope_id = $1
           AND id = $2
           AND status = 'processing'
           AND claim_token = $3::uuid
           AND (
             provider_message_id IS NULL
             OR provider_message_id = $4
           )`,
        [authorization.ownerScopeId, deliveryId, claimToken, providerMessageId],
      );
      if (result.rowCount !== 1) {
        const current = await loadDeliveryById(
          client,
          authorization.ownerScopeId,
          deliveryId,
        );
        if (
          current === null ||
          current.status !== "submitted" ||
          current.provider_message_id !== providerMessageId
        ) {
          throw new DeliveryError("conflicting_duplicate");
        }
      }
      const delivery = required(
        await loadDeliveryById(client, authorization.ownerScopeId, deliveryId),
      );
      return materializeDelivery(client, authorization.ownerScopeId, delivery);
    });
  }

  async markDispatchFailed(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    failure: { readonly ambiguous: boolean; readonly code: string },
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await client.query(
        `UPDATE quiz_delivery
         SET status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
             attempt_count = attempt_count + 1,
             claim_token = NULL,
             lease_expires_at = NULL,
             sanitized_error = jsonb_build_object(
               'class', $5::text,
               'ambiguous', $4::boolean
             ),
             updated_at = now()
         WHERE owner_scope_id = $1
           AND id = $2
           AND status = 'processing'
           AND claim_token = $3::uuid`,
        [
          authorization.ownerScopeId,
          deliveryId,
          claimToken,
          failure.ambiguous,
          failure.code,
        ],
      );
    });
  }

  async claimDispatch(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claim: { readonly leaseExpiresAt: string; readonly token: string },
  ): Promise<boolean> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query(
        `UPDATE quiz_delivery
         SET status = 'processing',
             claim_token = $3::uuid,
             lease_expires_at = $4::timestamptz,
             updated_at = now()
         WHERE owner_scope_id = $1
           AND id = $2
           AND status = 'pending'
           AND claim_token IS NULL`,
        [
          authorization.ownerScopeId,
          deliveryId,
          claim.token,
          claim.leaseExpiresAt,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async loadEmailPreview(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    now: string,
  ): Promise<EmailQuizPreview | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const delivery = await client.query<DeliveryRow>(
        `${DELIVERY_SELECT}
         WHERE delivery.owner_scope_id = $1
           AND delivery.id = $2
           AND delivery.provider = 'email'
           AND delivery.email_token_digest = $3
           AND delivery.email_token_expires_at >= $4::timestamptz
           AND delivery.email_token_redeemed_at IS NULL
           AND delivery.status IN ('submitted', 'delivered')`,
        [authorization.ownerScopeId, deliveryId, tokenDigest, now],
      );
      const row = delivery.rows[0];
      if (row === undefined) {
        return null;
      }
      const materialized = await materializeDelivery(
        client,
        authorization.ownerScopeId,
        row,
      );
      return {
        deliveryId,
        expiresAt: materialized.expiresAt,
        questions: materialized.items.map((item) => ({
          conceptId: item.conceptId,
          deliveryItemId: item.deliveryItemId,
          prompt: item.prompt,
          quizItemId: item.quizItemId,
          responseOptions: item.responseOptions,
        })),
      };
    });
  }

  async finalizeAnswers(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly answers: readonly DeliveryAnswerInput[];
      readonly deliveryId: string;
      readonly providerSubmissionId: string;
      readonly submittedAt: string;
      readonly tokenDigest: string | null;
    },
  ): Promise<readonly DeliveryAnswerFinalization[]> {
    assertAuthorization(authorization, destination);
    const requestDigest = sha256(
      canonicalJson({
        answers: [...request.answers].sort((left, right) =>
          compareAscii(left.deliveryItemId, right.deliveryItemId),
        ),
        deliveryId: request.deliveryId,
        provider: destination.provider,
        providerSubmissionId: request.providerSubmissionId,
      }),
    );
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await advisoryLock(
        client,
        `${destination.provider}/${request.providerSubmissionId}`,
      );
      await assertDestination(client, destination);
      const delivery = required(
        await loadDeliveryById(
          client,
          authorization.ownerScopeId,
          request.deliveryId,
        ),
      );
      if (
        delivery.provider !== destination.provider ||
        delivery.expires_at.getTime() < Date.parse(request.submittedAt) ||
        !["submitted", "delivered"].includes(delivery.status)
      ) {
        throw new DeliveryError("authorization_denied");
      }
      const replay = await client.query<SubmissionRow>(
        `SELECT request_digest
         FROM delivery_submission
         WHERE owner_scope_id = $1
           AND provider = $2
           AND provider_submission_id = $3`,
        [
          authorization.ownerScopeId,
          destination.provider,
          request.providerSubmissionId,
        ],
      );
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].request_digest !== requestDigest) {
          throw new DeliveryError("conflicting_duplicate");
        }
        return loadFinalizations(client, authorization, request, "replayed");
      }
      if (
        destination.provider === "email" &&
        (request.tokenDigest === null ||
          delivery.email_token_digest !== request.tokenDigest ||
          delivery.email_token_redeemed_at !== null)
      ) {
        throw new DeliveryError("link_redeemed");
      }
      const allItems = await loadDeliveryItems(
        client,
        authorization.ownerScopeId,
        request.deliveryId,
      );
      if (
        request.answers.length < 1 ||
        request.answers.length > allItems.length ||
        (destination.provider === "email" &&
          request.answers.length !== allItems.length) ||
        new Set(request.answers.map((answer) => answer.deliveryItemId)).size !==
          request.answers.length
      ) {
        throw new DeliveryError("invalid_input");
      }
      const byId = new Map(
        allItems.map((item) => [item.delivery_item_id, item]),
      );
      for (const answer of request.answers) {
        if (!byId.has(answer.deliveryItemId)) {
          throw new DeliveryError("authorization_denied");
        }
      }
      await client.query(
        `INSERT INTO delivery_submission
           (owner_scope_id, provider, provider_submission_id, delivery_id,
            user_id, request_digest, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          authorization.ownerScopeId,
          destination.provider,
          request.providerSubmissionId,
          request.deliveryId,
          authorization.actorId,
          requestDigest,
          request.submittedAt,
        ],
      );

      let replayedLogicalAnswer = false;
      for (const answer of request.answers) {
        const item = required(byId.get(answer.deliveryItemId));
        const options = responseOptions(item.response_options);
        const selected = /^\d+$/.test(answer.answer)
          ? options[Number(answer.answer)]
          : answer.answer;
        if (selected === undefined || !options.includes(selected)) {
          throw new DeliveryError("invalid_input");
        }
        const existingAttempt = await client.query<{
          answer: Record<string, unknown>;
        }>(
          `SELECT answer
           FROM attempt
           WHERE owner_scope_id = $1
             AND delivery_item_id = $2
           FOR UPDATE`,
          [authorization.ownerScopeId, item.delivery_item_id],
        );
        if (existingAttempt.rows[0] !== undefined) {
          if (existingAttempt.rows[0].answer.selectedAnswer !== selected) {
            throw new DeliveryError("conflicting_duplicate");
          }
          replayedLogicalAnswer = true;
          continue;
        }
        const attemptId = stableUuid({
          deliveryItemId: item.delivery_item_id,
          provider: destination.provider,
          providerSubmissionId: request.providerSubmissionId,
        });
        await client.query(
          `INSERT INTO attempt
             (id, owner_scope_id, user_id, delivery_item_id, provider,
              provider_submission_id, submission_idempotency_key,
              quiz_item_id, answer, outcome, grader_provenance,
              grading_policy_version, rating_mapping_version, created_at)
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             jsonb_build_object('selectedAnswer', $9::text),
             'graded',
             jsonb_build_object(
               'contractVersion', 'demo-delivery-v1',
               'gradingMethod', 'keyed_mc'
             ),
             'grading-policy-v1', 'rating-mapping-v1', $10::timestamptz
           )`,
          [
            attemptId,
            authorization.ownerScopeId,
            authorization.actorId,
            item.delivery_item_id,
            destination.provider,
            `${request.providerSubmissionId}/${item.delivery_item_id}`,
            `demo-delivery-v1/${destination.provider}/${request.providerSubmissionId}/${item.delivery_item_id}`,
            item.quiz_item_id,
            selected,
            request.submittedAt,
          ],
        );
      }

      if (destination.provider === "email") {
        await client.query(
          `UPDATE quiz_delivery
           SET email_token_redeemed_at = $3::timestamptz,
               updated_at = now()
           WHERE owner_scope_id = $1
             AND id = $2
             AND email_token_redeemed_at IS NULL`,
          [authorization.ownerScopeId, request.deliveryId, request.submittedAt],
        );
      }
      const answered = await client.query<{ count: number }>(
        `SELECT count(DISTINCT attempt.delivery_item_id)::integer AS count
         FROM attempt
         JOIN delivery_item
           ON delivery_item.owner_scope_id = attempt.owner_scope_id
          AND delivery_item.id = attempt.delivery_item_id
         WHERE delivery_item.owner_scope_id = $1
           AND delivery_item.delivery_id = $2`,
        [authorization.ownerScopeId, request.deliveryId],
      );
      if (answered.rows[0]?.count === allItems.length) {
        await client.query(
          `UPDATE quiz_delivery
           SET status = 'delivered', updated_at = now()
           WHERE owner_scope_id = $1 AND id = $2`,
          [authorization.ownerScopeId, request.deliveryId],
        );
      }
      const localDate = await recordStreakDay(
        client,
        authorization,
        request.deliveryId,
        allItems[0]!,
        request.submittedAt,
      );
      await updateStreak(client, authorization, localDate);
      return loadFinalizations(
        client,
        authorization,
        request,
        replayedLogicalAnswer ? "replayed" : "created",
      );
    });
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function materializePreference(
  row: PreferenceRow | undefined,
): DeliveryPreferenceSettings | null {
  return row === undefined
    ? null
    : {
        chosenLocalTime: row.chosen_local_time.slice(0, 5),
        provider: row.provider,
        timeZone: row.time_zone,
      };
}

const DELIVERY_SELECT = `SELECT delivery.id, delivery.provider,
  delivery.provider_message_id, delivery.idempotency_key,
  delivery.request_digest, delivery.status, delivery.attempt_count,
  delivery.expires_at, delivery.email_token_digest,
  delivery.email_token_expires_at, delivery.email_token_redeemed_at
  FROM quiz_delivery AS delivery`;

async function loadDeliveryById(
  client: PoolClient,
  ownerScopeId: string,
  deliveryId: string,
): Promise<DeliveryRow | null> {
  const result = await client.query<DeliveryRow>(
    `${DELIVERY_SELECT}
     WHERE delivery.owner_scope_id = $1 AND delivery.id = $2`,
    [ownerScopeId, deliveryId],
  );
  return result.rows[0] ?? null;
}

async function loadDeliveryByIdempotency(
  client: PoolClient,
  ownerScopeId: string,
  provider: string,
  idempotencyKey: string,
): Promise<DeliveryRow | null> {
  const result = await client.query<DeliveryRow>(
    `${DELIVERY_SELECT}
     WHERE delivery.owner_scope_id = $1
       AND delivery.provider = $2
       AND delivery.idempotency_key = $3`,
    [ownerScopeId, provider, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function loadDeliveryItems(
  client: PoolClient,
  ownerScopeId: string,
  deliveryId: string,
): Promise<DeliveryItemRow[]> {
  const result = await client.query<DeliveryItemRow>(
    `SELECT item.id AS delivery_item_id, item.review_schedule_id,
            item.quiz_item_id, question.prompt,
            question.keyed_answer #>> '{}' AS keyed_answer,
            question.response_options,
            question.version AS quiz_item_version,
            concept_link.concept_id,
            schedule.time_zone,
            schedule.chosen_local_time::text
     FROM delivery_item AS item
     JOIN quiz_item AS question
       ON question.owner_scope_id = item.owner_scope_id
      AND question.id = item.quiz_item_id
     JOIN quiz_item_concept AS concept_link
       ON concept_link.owner_scope_id = question.owner_scope_id
      AND concept_link.quiz_item_id = question.id
     JOIN review_schedule AS schedule
       ON schedule.owner_scope_id = item.owner_scope_id
      AND schedule.id = item.review_schedule_id
      AND schedule.concept_id = concept_link.concept_id
     WHERE item.owner_scope_id = $1 AND item.delivery_id = $2
     ORDER BY item.item_order`,
    [ownerScopeId, deliveryId],
  );
  return result.rows;
}

async function materializeDelivery(
  client: PoolClient,
  ownerScopeId: string,
  row: DeliveryRow,
): Promise<ReservedDelivery> {
  const items = await loadDeliveryItems(client, ownerScopeId, row.id);
  return {
    deliveryId: row.id,
    expiresAt: row.expires_at.toISOString(),
    items: items.map(materializeItem),
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    status: row.status,
  };
}

function materializeItem(row: DeliveryItemRow): ReservedDeliveryItem {
  const options = responseOptions(row.response_options);
  if (!options.includes(row.keyed_answer)) {
    throw new DeliveryError("invalid_configuration");
  }
  return {
    conceptId: row.concept_id,
    deliveryItemId: row.delivery_item_id,
    keyedAnswer: row.keyed_answer,
    prompt: row.prompt,
    quizItemId: row.quiz_item_id,
    responseOptions: options,
    reviewScheduleId: row.review_schedule_id,
    rubricId: `keyed-mc/${row.quiz_item_id}`,
    rubricVersion: row.quiz_item_version,
  };
}

async function assertDestination(
  client: PoolClient,
  destination: DemoDeliveryDestination,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM channel_identity
     WHERE owner_scope_id = $1
       AND user_id = $2
       AND id = $3
       AND provider = $4
       AND identity_class = 'demo_staff'
       AND external_id_lookup_digest = decode($5, 'hex')
       AND verified_at IS NOT NULL
       AND revoked_at IS NULL`,
    [
      destination.authorization.ownerScopeId,
      destination.authorization.actorId,
      destination.channelIdentityId,
      destination.provider,
      destination.recipientLookupDigest,
    ],
  );
  if (result.rowCount !== 1) {
    throw new DeliveryError("authorization_denied");
  }
}

async function loadFinalizations(
  client: PoolClient,
  authorization: KnowledgeAuthorizationContext,
  request: {
    readonly answers: readonly DeliveryAnswerInput[];
    readonly deliveryId: string;
    readonly providerSubmissionId: string;
  },
  status: "created" | "replayed",
): Promise<DeliveryAnswerFinalization[]> {
  const result = await client.query<AttemptReplayRow>(
    `SELECT attempt.id AS attempt_id, attempt.answer,
            item.id AS delivery_item_id, item.review_schedule_id,
            item.quiz_item_id, question.prompt,
            question.keyed_answer #>> '{}' AS keyed_answer,
            question.response_options,
            question.version AS quiz_item_version,
            concept_link.concept_id,
            schedule.time_zone,
            schedule.chosen_local_time::text
     FROM attempt
     JOIN delivery_item AS item
       ON item.owner_scope_id = attempt.owner_scope_id
      AND item.id = attempt.delivery_item_id
     JOIN quiz_item AS question
       ON question.owner_scope_id = attempt.owner_scope_id
      AND question.id = attempt.quiz_item_id
     JOIN quiz_item_concept AS concept_link
       ON concept_link.owner_scope_id = question.owner_scope_id
      AND concept_link.quiz_item_id = question.id
     JOIN review_schedule AS schedule
       ON schedule.owner_scope_id = item.owner_scope_id
      AND schedule.id = item.review_schedule_id
      AND schedule.concept_id = concept_link.concept_id
     WHERE attempt.owner_scope_id = $1
       AND item.delivery_id = $2
       AND item.id = ANY($3::uuid[])
     ORDER BY item.item_order`,
    [
      authorization.ownerScopeId,
      request.deliveryId,
      request.answers.map((answer) => answer.deliveryItemId),
    ],
  );
  const streak = await client.query<StreakRow>(
    `SELECT current_streak, longest_streak,
            last_answered_on::text
     FROM delivery_streak
     WHERE owner_scope_id = $1 AND user_id = $2`,
    [authorization.ownerScopeId, authorization.actorId],
  );
  const projection = required(streak.rows[0]);
  return result.rows.map((row) => {
    const item = materializeItem(row);
    const selected = row.answer.selectedAnswer;
    if (typeof selected !== "string") {
      throw new DeliveryError("invalid_configuration");
    }
    const correct = selected === item.keyedAnswer;
    return {
      attemptId: row.attempt_id,
      correct,
      deliveryId: request.deliveryId,
      deliveryPreference: {
        chosenLocalTime: row.chosen_local_time.slice(0, 5),
        timeZone: row.time_zone,
      },
      evidence: {
        attemptId: row.attempt_id,
        conceptId: item.conceptId,
        eligibleForMastery: true,
        fsrsRating: correct ? 3 : 1,
        graderConfidence: null,
        gradingMethod: "keyed_mc",
        gradingPolicyVersion: "grading-policy-v1",
        ineligibilityReason: null,
        judgmentKind: "scored",
        knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
        knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
        rationaleRef: `keyed-mc/${item.quizItemId}`,
        ratingMappingVersion: "rating-mapping-v1",
        replacementForAttemptId: null,
        rubricBand: correct ? "correct" : "incorrect",
        rubricId: item.rubricId,
        rubricVersion: item.rubricVersion,
        score: correct ? "1.00000" : "0.00000",
        unanswerableReason: null,
      },
      status,
      streak: {
        current: projection.current_streak,
        longest: projection.longest_streak,
      },
    };
  });
}

async function recordStreakDay(
  client: PoolClient,
  authorization: KnowledgeAuthorizationContext,
  deliveryId: string,
  item: DeliveryItemRow,
  submittedAt: string,
): Promise<string> {
  const result = await client.query<{ local_date: string }>(
    `INSERT INTO delivery_streak_day
       (owner_scope_id, user_id, local_date, time_zone, delivery_id)
     VALUES (
       $1, $2, ($3::timestamptz AT TIME ZONE $4)::date, $4, $5
     )
     ON CONFLICT DO NOTHING
     RETURNING local_date::text`,
    [
      authorization.ownerScopeId,
      authorization.actorId,
      submittedAt,
      item.time_zone,
      deliveryId,
    ],
  );
  if (result.rows[0] !== undefined) {
    return result.rows[0].local_date;
  }
  const existing = await client.query<{ local_date: string }>(
    `SELECT (($3::timestamptz AT TIME ZONE $4)::date)::text AS local_date
     FROM delivery_streak_day
     WHERE owner_scope_id = $1
       AND user_id = $2
       AND local_date = ($3::timestamptz AT TIME ZONE $4)::date`,
    [
      authorization.ownerScopeId,
      authorization.actorId,
      submittedAt,
      item.time_zone,
    ],
  );
  return required(existing.rows[0]).local_date;
}

async function updateStreak(
  client: PoolClient,
  authorization: KnowledgeAuthorizationContext,
  localDate: string,
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_streak
       (owner_scope_id, user_id, current_streak, longest_streak,
        last_answered_on)
     VALUES ($1, $2, 1, 1, $3::date)
     ON CONFLICT (owner_scope_id, user_id) DO UPDATE
     SET current_streak = CASE
           WHEN EXCLUDED.last_answered_on < delivery_streak.last_answered_on
             THEN delivery_streak.current_streak
           WHEN delivery_streak.last_answered_on = EXCLUDED.last_answered_on
             THEN delivery_streak.current_streak
           WHEN delivery_streak.last_answered_on =
                EXCLUDED.last_answered_on - 1
             THEN delivery_streak.current_streak + 1
           ELSE 1
         END,
         longest_streak = greatest(
           delivery_streak.longest_streak,
           CASE
             WHEN EXCLUDED.last_answered_on <
                  delivery_streak.last_answered_on
               THEN delivery_streak.current_streak
             WHEN delivery_streak.last_answered_on =
                  EXCLUDED.last_answered_on - 1
               THEN delivery_streak.current_streak + 1
             WHEN delivery_streak.last_answered_on =
                  EXCLUDED.last_answered_on
               THEN delivery_streak.current_streak
             ELSE 1
           END
         ),
         last_answered_on = greatest(
           delivery_streak.last_answered_on,
           EXCLUDED.last_answered_on
         ),
         updated_at = now()`,
    [authorization.ownerScopeId, authorization.actorId, localDate],
  );
}

async function setScopeContext(
  client: PoolClient,
  authorization: KnowledgeAuthorizationContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('reflo.actor_id', $1, true),
            set_config('reflo.owner_scope_id', $2, true)`,
    [authorization.actorId, authorization.ownerScopeId],
  );
  const active = await client.query(
    `SELECT 1
     FROM scope_membership
     JOIN owner_scope ON owner_scope.id = scope_membership.owner_scope_id
     WHERE scope_membership.owner_scope_id = $1
       AND scope_membership.user_id = $2
       AND scope_membership.revoked_at IS NULL
       AND owner_scope.status = 'active'`,
    [authorization.ownerScopeId, authorization.actorId],
  );
  if (active.rowCount !== 1) {
    throw new DeliveryError("authorization_denied");
  }
}

async function advisoryLock(client: PoolClient, value: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [value]);
}

function assertAuthorization(
  authorization: KnowledgeAuthorizationContext,
  destination: DemoDeliveryDestination,
): void {
  if (
    authorization.actorId !== destination.authorization.actorId ||
    authorization.ownerScopeId !== destination.authorization.ownerScopeId
  ) {
    throw new DeliveryError("authorization_denied");
  }
}

function responseOptions(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.some((option) => typeof option !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new DeliveryError("invalid_configuration");
  }
  return value as string[];
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new DeliveryError("not_found");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
