import { randomUUID } from "node:crypto";

import {
  AssessmentError,
  type AssessmentEvidenceCandidate,
  type AssessmentFinalizationView,
  type AssessmentRepositoryPort,
  type AuthorizedShortAnswerSnapshot,
  type KeyedMultipleChoiceQuestion,
  type LearnerMultipleChoiceQuestion,
  type ReplacementBundle,
  type ReplacementAnswerResolution,
  type ReplacementFinalization,
  type ShortAnswerQuestion,
  type ShortAnswerFinalization,
} from "@reflo/assessment";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
} from "@reflo/knowledge-model";
import { canonicalJson, sha256, stableUuid } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface FinalizationRow extends Record<string, unknown> {
  attempt_id: string;
  attempt_outcome: "abstained" | "graded";
  learner_message: string;
  replacement_for_attempt_id: string | null;
  request_digest: string;
}

interface EvidenceRow extends Record<string, unknown> {
  concept_id: string;
  eligible_for_mastery: boolean;
  fsrs_rating: 1 | 3 | null;
  grader_confidence: string | null;
  grading_method: "keyed_mc" | "llm_short_answer";
  ineligibility_reason:
    "attempt_abstained" | "below_threshold" | "semantic_unanswerable" | null;
  judgment_kind: "scored" | "unanswerable";
  rationale_ref: string;
  rubric_band: "correct" | "incorrect" | "partially_correct" | null;
  rubric_id: string;
  rubric_version: string;
  score: string | null;
  unanswerable_reason:
    | "source_insufficient"
    | "source_conflict"
    | "rubric_insufficient"
    | "rubric_conflict"
    | null;
}

interface ReplacementItemRow extends Record<string, unknown> {
  concept_id: string;
  course_id: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  id: string;
  normalized_prompt_hash: string;
  prompt: string;
  quiz_item_id: string;
  response_options: readonly string[];
  rubric_id: string;
  rubric_version: string;
  source_spans: readonly { readonly id: string; readonly text: string }[];
}

interface AuthorizedFallbackRow extends ReplacementItemRow {
  keyed_answer: string;
}

interface AuthorizedQuestionRow extends Record<string, unknown> {
  concept_ids: readonly string[];
  course_id: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  id: string;
  keyed_answer: string;
  normalized_prompt_hash: string;
  prompt: string;
  rubric: unknown;
  source_spans: readonly { readonly id: string; readonly text: string }[];
}

interface GradingOperationRow extends Record<string, unknown> {
  authorized_snapshot: AuthorizedShortAnswerSnapshot;
  claim_token: string | null;
  lease_active: boolean;
  request_digest: string;
  status: "finalized" | "processing";
}

export class PostgresAssessmentRepository implements AssessmentRepositoryPort {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new AssessmentError("invalid_configuration");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async claimShortAnswer(
    authorization: Parameters<AssessmentRepositoryPort["claimShortAnswer"]>[0],
    request: Parameters<AssessmentRepositoryPort["claimShortAnswer"]>[1],
  ): ReturnType<AssessmentRepositoryPort["claimShortAnswer"]> {
    if (
      !Number.isSafeInteger(request.leaseMs) ||
      request.leaseMs < 1 ||
      request.leaseMs > 120_000
    ) {
      throw new AssessmentError("invalid_input");
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await ensurePolicyBinding(client, request.policy);
      const session = await client.query<{ id: string }>(
        `SELECT id
         FROM study_session
         WHERE owner_scope_id = $1
           AND id = $2
           AND user_id = $3
           AND status = 'active'
         FOR UPDATE`,
        [authorization.ownerScopeId, request.sessionId, authorization.actorId],
      );
      if (session.rows[0] === undefined) {
        throw new AssessmentError("authorization_denied");
      }

      const current = await loadGradingOperation(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        request.idempotencyKey,
      );
      if (current !== null) {
        if (current.request_digest !== request.requestDigest) {
          throw new AssessmentError("conflicting_duplicate");
        }
        if (current.status === "finalized") {
          const finalization = await loadFinalizationView(
            client,
            authorization.ownerScopeId,
            authorization.actorId,
            request.idempotencyKey,
            "replayed",
          );
          if (finalization === null) {
            throw new AssessmentError("invalid_result");
          }
          return { finalization, kind: "finalized" };
        }
        if (current.claim_token !== null && current.lease_active) {
          return { kind: "pending" };
        }
        const claimToken = randomUUID();
        await client.query(
          `UPDATE assessment_grading_operation
           SET claim_token = $4,
               lease_expires_at = now() + ($5::integer * interval '1 millisecond')
           WHERE owner_scope_id = $1
             AND idempotency_key = $2
             AND user_id = $3
             AND status = 'processing'`,
          [
            authorization.ownerScopeId,
            request.idempotencyKey,
            authorization.actorId,
            claimToken,
            request.leaseMs,
          ],
        );
        return {
          claimToken,
          kind: "claimed",
          snapshot: current.authorized_snapshot,
        };
      }

      const snapshot = await loadAuthorizedSnapshot(
        client,
        authorization,
        request.sessionId,
        request.questionId,
      );
      const claimToken = randomUUID();
      await client.query(
        `INSERT INTO assessment_grading_operation
           (owner_scope_id, idempotency_key, user_id, session_id, question_id,
            request_digest, grading_policy_version, policy_binding_digest,
            authorized_snapshot, claim_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
                 now() + ($11::integer * interval '1 millisecond'))`,
        [
          authorization.ownerScopeId,
          request.idempotencyKey,
          authorization.actorId,
          request.sessionId,
          request.questionId,
          request.requestDigest,
          request.policy.gradingPolicyVersion,
          policyBindingDigest(request.policy),
          JSON.stringify(snapshot),
          claimToken,
          request.leaseMs,
        ],
      );
      await reserveSessionQuestions(
        client,
        authorization.ownerScopeId,
        request.sessionId,
        request.idempotencyKey,
        snapshot,
      );
      return { claimToken, kind: "claimed", snapshot };
    });
  }

  async loadFinalization(
    authorization: Parameters<AssessmentRepositoryPort["loadFinalization"]>[0],
    idempotencyKey: string,
  ): Promise<AssessmentFinalizationView | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      return loadFinalizationView(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        idempotencyKey,
        "replayed",
      );
    });
  }

  async loadPendingFallback(
    authorization: Parameters<AssessmentRepositoryPort["loadFinalization"]>[0],
    sessionId: string,
  ): Promise<AssessmentFinalizationView | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const pending = await client.query<{ idempotency_key: string }>(
        `SELECT finalization.idempotency_key
         FROM assessment_finalization AS finalization
         JOIN attempt AS original
           ON original.owner_scope_id = finalization.owner_scope_id
          AND original.id = finalization.attempt_id
         WHERE finalization.owner_scope_id = $1
           AND finalization.user_id = $2
           AND finalization.finalization_kind = 'short_answer'
           AND finalization.attempt_outcome = 'abstained'
           AND original.session_id = $3
           AND NOT EXISTS (
             SELECT 1
             FROM attempt AS replacement
             WHERE replacement.owner_scope_id = original.owner_scope_id
               AND replacement.user_id = original.user_id
               AND replacement.replacement_for_attempt_id = original.id
           )
         ORDER BY finalization.created_at DESC, finalization.attempt_id DESC
         LIMIT 1`,
        [authorization.ownerScopeId, authorization.actorId, sessionId],
      );
      const idempotencyKey = pending.rows[0]?.idempotency_key;
      return idempotencyKey === undefined
        ? null
        : loadFinalizationView(
            client,
            authorization.ownerScopeId,
            authorization.actorId,
            idempotencyKey,
            "replayed",
          );
    });
  }

  async loadReplacementBundle(
    authorization: Parameters<
      AssessmentRepositoryPort["loadReplacementBundle"]
    >[0],
    bundleId: string,
  ): Promise<ReplacementBundle | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      return loadReplacementBundle(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        bundleId,
      );
    });
  }

  async releaseShortAnswerClaim(
    authorization: Parameters<
      AssessmentRepositoryPort["releaseShortAnswerClaim"]
    >[0],
    idempotencyKey: string,
    claimToken: string,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await client.query(
        `UPDATE assessment_grading_operation
         SET claim_token = NULL, lease_expires_at = NULL
         WHERE owner_scope_id = $1
           AND idempotency_key = $2
           AND user_id = $3
           AND claim_token = $4
           AND status = 'processing'`,
        [
          authorization.ownerScopeId,
          idempotencyKey,
          authorization.actorId,
          claimToken,
        ],
      );
    });
  }

  async resolveReplacementAnswer(
    authorization: Parameters<
      AssessmentRepositoryPort["resolveReplacementAnswer"]
    >[0],
    request: Parameters<
      AssessmentRepositoryPort["resolveReplacementAnswer"]
    >[1],
  ): Promise<ReplacementAnswerResolution | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const resolved = await client.query<{ keyed_answer: string }>(
        `SELECT item.keyed_answer #>> '{}' AS keyed_answer
         FROM assessment_replacement_item AS item
         JOIN assessment_replacement_bundle AS bundle
           ON bundle.owner_scope_id = item.owner_scope_id
          AND bundle.id = item.bundle_id
         JOIN attempt AS original
           ON original.owner_scope_id = bundle.owner_scope_id
          AND original.id = bundle.original_attempt_id
         WHERE item.owner_scope_id = $1
           AND item.bundle_id = $2
           AND item.id = $3
           AND original.user_id = $4
           AND original.outcome = 'abstained'`,
        [
          authorization.ownerScopeId,
          request.bundleId,
          request.itemId,
          authorization.actorId,
        ],
      );
      const keyedAnswer = resolved.rows[0]?.keyed_answer;
      if (keyedAnswer === undefined) return null;
      const bundle = await loadReplacementBundle(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        request.bundleId,
      );
      const item = bundle?.items.find(
        (candidate) => candidate.id === request.itemId,
      );
      if (bundle === null || item === undefined) return null;
      return {
        bundle,
        correct: request.answer === keyedAnswer,
        item,
      };
    });
  }

  async finalizeShortAnswer(
    authorization: Parameters<
      AssessmentRepositoryPort["finalizeShortAnswer"]
    >[0],
    finalization: ShortAnswerFinalization,
  ): Promise<AssessmentFinalizationView> {
    assertAuthorization(authorization, finalization);
    const digest = finalization.requestDigest;
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const replay = await loadAndVerifyReplay(client, finalization, digest);
      if (replay !== null) return replay;
      await ensurePolicyBinding(client, finalization.policy);
      await assertGradingClaim(client, finalization);
      const inserted = await client.query<{ created_at_order: string }>(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, overall_grade, grading_confidence, grader_provenance,
            submission_idempotency_key, grading_policy_version,
            rating_mapping_version, replacement_for_attempt_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL, NULL, $8::jsonb,
                 $9, $10, $11, NULL)
         ON CONFLICT DO NOTHING
         RETURNING to_char(
           created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS created_at_order`,
        [
          finalization.attemptId,
          finalization.ownerScopeId,
          finalization.userId,
          finalization.sessionId,
          finalization.questionId,
          JSON.stringify({ text: finalization.answer }),
          finalization.outcome,
          JSON.stringify(finalization.modelProvenance ?? {}),
          finalization.idempotencyKey,
          finalization.policy.gradingPolicyVersion,
          finalization.policy.ratingMappingVersion,
        ],
      );
      const createdAt = inserted.rows[0]?.created_at_order;
      if (createdAt === undefined) {
        return requiredReplay(
          await loadAndVerifyReplay(client, finalization, digest),
        );
      }
      await insertEvidence(
        client,
        finalization,
        createdAt,
        finalization.evidence,
        null,
      );
      if (finalization.fallback !== null) {
        await insertReplacementBundle(
          client,
          finalization,
          finalization.fallback,
        );
      }
      await insertFinalization(client, finalization, digest, "short_answer");
      await completeGradingOperation(client, finalization);
      return requiredReplay(
        await loadFinalizationView(
          client,
          finalization.ownerScopeId,
          finalization.userId,
          finalization.idempotencyKey,
          "created",
        ),
      );
    });
  }

  async finalizeReplacement(
    authorization: Parameters<
      AssessmentRepositoryPort["finalizeReplacement"]
    >[0],
    finalization: ReplacementFinalization,
  ): Promise<AssessmentFinalizationView> {
    assertAuthorization(authorization, finalization);
    const digest = finalization.requestDigest;
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const replay = await loadAndVerifyReplay(client, finalization, digest);
      if (replay !== null) return replay;
      await ensurePolicyBinding(client, finalization.policy);
      const lineage = await client.query<{
        original_attempt_id: string;
        quiz_item_id: string;
        session_id: string;
      }>(
        `SELECT bundle.original_attempt_id, item.quiz_item_id,
                original.session_id
         FROM assessment_replacement_bundle AS bundle
         JOIN assessment_replacement_item AS item
           ON item.owner_scope_id = bundle.owner_scope_id
          AND item.bundle_id = bundle.id
         JOIN attempt AS original
           ON original.owner_scope_id = bundle.owner_scope_id
          AND original.id = bundle.original_attempt_id
         WHERE bundle.owner_scope_id = $1
           AND bundle.id = $2
           AND item.id = $3
           AND original.user_id = $4
           AND original.outcome = 'abstained'`,
        [
          finalization.ownerScopeId,
          finalization.bundleId,
          finalization.itemId,
          finalization.userId,
        ],
      );
      const source = lineage.rows[0];
      if (source === undefined) {
        throw new AssessmentError("authorization_denied");
      }
      if (source.session_id !== finalization.sessionId) {
        throw new AssessmentError("authorization_denied");
      }
      const inserted = await client.query<{ created_at_order: string }>(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, overall_grade, grading_confidence, grader_provenance,
            submission_idempotency_key, grading_policy_version,
            rating_mapping_version, replacement_for_attempt_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'graded', NULL, NULL,
                 $7::jsonb, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING
         RETURNING to_char(
           created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS created_at_order`,
        [
          finalization.attemptId,
          finalization.ownerScopeId,
          finalization.userId,
          finalization.sessionId,
          source.quiz_item_id,
          JSON.stringify({ option: finalization.answer }),
          JSON.stringify({
            gradingMethod: "keyed_mc",
            replacementBundleId: finalization.bundleId,
            replacementItemId: finalization.itemId,
          }),
          finalization.idempotencyKey,
          finalization.policy.gradingPolicyVersion,
          finalization.policy.ratingMappingVersion,
          source.original_attempt_id,
        ],
      );
      const createdAt = inserted.rows[0]?.created_at_order;
      if (createdAt === undefined) {
        return requiredReplay(
          await loadAndVerifyReplay(client, finalization, digest),
        );
      }
      await insertEvidence(
        client,
        finalization,
        createdAt,
        [finalization.evidence],
        source.original_attempt_id,
      );
      await insertFinalization(
        client,
        {
          ...finalization,
          learnerMessage:
            "The replacement answer was graded from its keyed option.",
          outcome: "graded",
        },
        digest,
        "keyed_mc_replacement",
      );
      return requiredReplay(
        await loadFinalizationView(
          client,
          finalization.ownerScopeId,
          finalization.userId,
          finalization.idempotencyKey,
          "created",
        ),
      );
    });
  }

  async #transaction<Value>(
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
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

async function loadGradingOperation(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  idempotencyKey: string,
): Promise<GradingOperationRow | null> {
  const result = await client.query<GradingOperationRow>(
    `SELECT authorized_snapshot, claim_token, request_digest, status,
            lease_expires_at > now() AS lease_active
     FROM assessment_grading_operation
     WHERE owner_scope_id = $1
       AND idempotency_key = $2
       AND user_id = $3`,
    [ownerScopeId, idempotencyKey, userId],
  );
  return result.rows[0] ?? null;
}

async function loadAuthorizedSnapshot(
  client: PoolClient,
  authorization: {
    readonly actorId: string;
    readonly ownerScopeId: string;
  },
  sessionId: string,
  questionId: string,
): Promise<AuthorizedShortAnswerSnapshot> {
  const questionResult = await client.query<AuthorizedQuestionRow>(
    `SELECT question.id, question.course_id, question.difficulty,
            question.prompt, question.normalized_prompt_hash, question.rubric,
            question.keyed_answer #>> '{}' AS keyed_answer,
            ARRAY(
              SELECT link.concept_id::text
              FROM quiz_item_concept AS link
              WHERE link.owner_scope_id = question.owner_scope_id
                AND link.quiz_item_id = question.id
              ORDER BY link.concept_id
            ) AS concept_ids,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object('id', span.id, 'text', span.canonical_text)
                ORDER BY span.id
              )
              FROM quiz_item_source_span AS source_link
              JOIN source_span AS span
                ON span.owner_scope_id = source_link.owner_scope_id
               AND span.id = source_link.source_span_id
              WHERE source_link.owner_scope_id = question.owner_scope_id
                AND source_link.quiz_item_id = question.id
            ), '[]'::jsonb) AS source_spans
     FROM quiz_item AS question
     JOIN study_session AS session
       ON session.owner_scope_id = question.owner_scope_id
      AND session.course_id = question.course_id
     WHERE question.owner_scope_id = $1
       AND question.id = $2
       AND question.item_type = 'short_answer'
       AND session.id = $3
       AND session.user_id = $4
       AND session.status = 'active'`,
    [authorization.ownerScopeId, questionId, sessionId, authorization.actorId],
  );
  const row = questionResult.rows[0];
  if (row === undefined) {
    throw new AssessmentError("authorization_denied");
  }
  const question = mapAuthorizedQuestion(row);
  const seenResult = await client.query<{ normalized_prompt_hash: string }>(
    `SELECT normalized_prompt_hash
     FROM assessment_session_question
     WHERE owner_scope_id = $1 AND session_id = $2
     UNION
     SELECT question.normalized_prompt_hash
     FROM attempt
     JOIN quiz_item AS question
       ON question.owner_scope_id = attempt.owner_scope_id
      AND question.id = attempt.quiz_item_id
     WHERE attempt.owner_scope_id = $1
       AND attempt.session_id = $2
       AND question.normalized_prompt_hash IS NOT NULL`,
    [authorization.ownerScopeId, sessionId],
  );
  const seen = new Set(
    seenResult.rows.map((entry) => entry.normalized_prompt_hash),
  );
  if (seen.has(question.normalizedPromptHash)) {
    throw new AssessmentError("question_unavailable");
  }
  seen.add(question.normalizedPromptHash);

  const fallbackResult = await client.query<AuthorizedFallbackRow>(
    `SELECT replacement.id AS quiz_item_id,
            replacement.course_id,
            replacement.difficulty,
            replacement.prompt,
            replacement.keyed_answer #>> '{}' AS keyed_answer,
            replacement.normalized_prompt_hash,
            replacement.response_options,
            link.concept_id,
            ''::text AS rubric_id,
            ''::text AS rubric_version,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object('id', span.id, 'text', span.canonical_text)
                ORDER BY span.id
              )
              FROM quiz_item_source_span AS source_link
              JOIN source_span AS span
                ON span.owner_scope_id = source_link.owner_scope_id
               AND span.id = source_link.source_span_id
              WHERE source_link.owner_scope_id = replacement.owner_scope_id
                AND source_link.quiz_item_id = replacement.id
            ), '[]'::jsonb) AS source_spans
     FROM quiz_item AS replacement
     JOIN quiz_item_concept AS link
       ON link.owner_scope_id = replacement.owner_scope_id
      AND link.quiz_item_id = replacement.id
     WHERE replacement.owner_scope_id = $1
       AND replacement.course_id = $2
       AND replacement.item_type = 'multiple_choice'
       AND replacement.normalized_prompt_hash IS NOT NULL
       AND (
         SELECT count(*)
         FROM quiz_item_concept AS all_links
         WHERE all_links.owner_scope_id = replacement.owner_scope_id
           AND all_links.quiz_item_id = replacement.id
       ) = 1
     ORDER BY replacement.id`,
    [authorization.ownerScopeId, question.courseId],
  );
  const fallbackCandidates: KeyedMultipleChoiceQuestion[] = [];
  for (const rubric of question.rubrics) {
    const existingCandidate = fallbackResult.rows.find(
      (entry) =>
        entry.concept_id === rubric.conceptId &&
        !seen.has(entry.normalized_prompt_hash) &&
        entry.source_spans.length > 0 &&
        entry.source_spans.every((span) =>
          rubric.sourceSpanIds.includes(span.id),
        ) &&
        entry.response_options.includes(entry.keyed_answer),
    );
    const candidate =
      existingCandidate ??
      (await createSourceBackedFallback(
        client,
        authorization.ownerScopeId,
        row,
        question,
        rubric,
        fallbackResult.rows,
      ));
    seen.add(candidate.normalized_prompt_hash);
    fallbackCandidates.push({
      conceptIds: [rubric.conceptId],
      courseId: candidate.course_id,
      difficulty: candidate.difficulty,
      id: candidate.quiz_item_id,
      itemType: "multiple_choice" as const,
      keyedAnswer: candidate.keyed_answer,
      normalizedPromptHash: candidate.normalized_prompt_hash,
      prompt: candidate.prompt,
      responseOptions: candidate.response_options,
      rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion,
      sourceSpans: candidate.source_spans,
    });
  }
  return { fallbackCandidates, question };
}

async function createSourceBackedFallback(
  client: PoolClient,
  ownerScopeId: string,
  row: AuthorizedQuestionRow,
  question: ShortAnswerQuestion,
  rubric: ShortAnswerQuestion["rubrics"][number],
  courseFallbacks: readonly AuthorizedFallbackRow[],
): Promise<AuthorizedFallbackRow> {
  if (
    question.conceptIds.length !== 1 ||
    row.keyed_answer.trim().length === 0
  ) {
    throw new AssessmentError("fallback_unavailable");
  }
  const responseOptions = new Set<string>([row.keyed_answer]);
  for (const fallback of courseFallbacks) {
    if (fallback.keyed_answer.trim().length > 0) {
      responseOptions.add(fallback.keyed_answer);
    }
    if (responseOptions.size === 4) break;
  }
  if (responseOptions.size === 1) {
    responseOptions.add(
      "The course material does not provide a supported answer.",
    );
  }
  const prompt = `Choose the course-supported answer: ${question.prompt}`;
  const normalizedPromptHash = sha256(normalizeQuizPrompt(prompt));
  const quizItemId = stableUuid({
    conceptId: rubric.conceptId,
    originalQuestionId: question.id,
    version: "short-answer-fallback-v1",
  });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, rubric, version, quiz_bank_id, item_order,
        normalized_prompt_hash, response_options)
     VALUES ($1, $2, $3, 'multiple_choice', $4, $5, $6::jsonb, NULL,
             'short-answer-fallback-v1', NULL, NULL, $7, $8::jsonb)
     ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
     WHERE quiz_item.course_id = EXCLUDED.course_id
       AND quiz_item.item_type = EXCLUDED.item_type
       AND quiz_item.prompt = EXCLUDED.prompt
       AND quiz_item.keyed_answer = EXCLUDED.keyed_answer
       AND quiz_item.normalized_prompt_hash = EXCLUDED.normalized_prompt_hash
       AND quiz_item.response_options = EXCLUDED.response_options
     RETURNING id`,
    [
      quizItemId,
      ownerScopeId,
      question.courseId,
      question.difficulty,
      prompt,
      JSON.stringify(row.keyed_answer),
      normalizedPromptHash,
      JSON.stringify([...responseOptions]),
    ],
  );
  if (inserted.rows[0]?.id !== quizItemId) {
    throw new AssessmentError("fallback_unavailable");
  }
  const conceptLink = await client.query<{ concept_id: string }>(
    `INSERT INTO quiz_item_concept (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING concept_id`,
    [ownerScopeId, quizItemId, rubric.conceptId],
  );
  if (conceptLink.rows[0]?.concept_id === undefined) {
    const existing = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM quiz_item_concept
         WHERE owner_scope_id = $1 AND quiz_item_id = $2 AND concept_id = $3
       ) AS present`,
      [ownerScopeId, quizItemId, rubric.conceptId],
    );
    if (existing.rows[0]?.present !== true) {
      throw new AssessmentError("fallback_unavailable");
    }
  }
  for (const sourceSpanId of rubric.sourceSpanIds) {
    await client.query(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [ownerScopeId, quizItemId, sourceSpanId],
    );
  }
  const sourceSpans = question.sourceSpans.filter((span) =>
    rubric.sourceSpanIds.includes(span.id),
  );
  if (sourceSpans.length !== rubric.sourceSpanIds.length) {
    throw new AssessmentError("fallback_unavailable");
  }
  return {
    concept_id: rubric.conceptId,
    course_id: question.courseId,
    difficulty: question.difficulty,
    id: quizItemId,
    keyed_answer: row.keyed_answer,
    normalized_prompt_hash: normalizedPromptHash,
    prompt,
    quiz_item_id: quizItemId,
    response_options: [...responseOptions],
    rubric_id: rubric.rubricId,
    rubric_version: rubric.rubricVersion,
    source_spans: sourceSpans,
  };
}

function normalizeQuizPrompt(prompt: string): string {
  return prompt
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mapAuthorizedQuestion(
  row: AuthorizedQuestionRow,
): ShortAnswerQuestion {
  if (
    !/^[0-9a-f]{64}$/.test(row.normalized_prompt_hash) ||
    !Array.isArray(row.rubric) ||
    !Array.isArray(row.concept_ids) ||
    !Array.isArray(row.source_spans)
  ) {
    throw new AssessmentError("invalid_input");
  }
  const rubrics = row.rubric.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.conceptId !== "string" ||
      typeof value.rubricId !== "string" ||
      typeof value.rubricVersion !== "string" ||
      !isStringArray(value.requiredCriteria) ||
      value.requiredCriteria.length === 0 ||
      !isStringArray(value.materialContradictions) ||
      !isStringArray(value.sourceSpanIds) ||
      value.sourceSpanIds.length === 0
    ) {
      throw new AssessmentError("invalid_input");
    }
    return {
      conceptId: value.conceptId,
      materialContradictions: value.materialContradictions,
      requiredCriteria: value.requiredCriteria,
      rubricId: value.rubricId,
      rubricVersion: value.rubricVersion,
      sourceSpanIds: value.sourceSpanIds,
    };
  });
  const conceptIds = [...row.concept_ids].sort(compareAscii);
  const sourceIds = new Set(row.source_spans.map((span) => span.id));
  if (
    rubrics.length !== conceptIds.length ||
    new Set(rubrics.map((rubric) => rubric.conceptId)).size !==
      conceptIds.length ||
    rubrics.some(
      (rubric) =>
        !conceptIds.includes(rubric.conceptId) ||
        rubric.requiredCriteria.some((criterion) => criterion.length === 0) ||
        rubric.materialContradictions.some(
          (contradiction) => contradiction.length === 0,
        ) ||
        rubric.sourceSpanIds.some((spanId) => !sourceIds.has(spanId)),
    )
  ) {
    throw new AssessmentError("invalid_input");
  }
  return {
    conceptIds,
    courseId: row.course_id,
    difficulty: row.difficulty,
    id: row.id,
    itemType: "short_answer",
    normalizedPromptHash: row.normalized_prompt_hash,
    prompt: row.prompt,
    rubrics,
    sourceSpans: row.source_spans,
  };
}

async function reserveSessionQuestions(
  client: PoolClient,
  ownerScopeId: string,
  sessionId: string,
  operationIdempotencyKey: string,
  snapshot: AuthorizedShortAnswerSnapshot,
): Promise<void> {
  await client.query(
    `INSERT INTO assessment_session_question
       (owner_scope_id, session_id, normalized_prompt_hash, quiz_item_id,
        operation_idempotency_key, presentation_kind, presented_at)
     VALUES ($1, $2, $3, $4, $5, 'original', now())`,
    [
      ownerScopeId,
      sessionId,
      snapshot.question.normalizedPromptHash,
      snapshot.question.id,
      operationIdempotencyKey,
    ],
  );
  for (const fallback of snapshot.fallbackCandidates) {
    await client.query(
      `INSERT INTO assessment_session_question
         (owner_scope_id, session_id, normalized_prompt_hash, quiz_item_id,
          operation_idempotency_key, presentation_kind, presented_at)
       VALUES ($1, $2, $3, $4, $5, 'fallback', NULL)`,
      [
        ownerScopeId,
        sessionId,
        fallback.normalizedPromptHash,
        fallback.id,
        operationIdempotencyKey,
      ],
    );
  }
}

async function assertGradingClaim(
  client: PoolClient,
  finalization: ShortAnswerFinalization,
): Promise<void> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM assessment_grading_operation
       WHERE owner_scope_id = $1
         AND idempotency_key = $2
         AND user_id = $3
         AND session_id = $4
         AND question_id = $5
         AND request_digest = $6
         AND claim_token = $7
         AND status = 'processing'
     ) AS valid`,
    [
      finalization.ownerScopeId,
      finalization.idempotencyKey,
      finalization.userId,
      finalization.sessionId,
      finalization.questionId,
      finalization.requestDigest,
      finalization.claimToken,
    ],
  );
  if (
    result.rows[0]?.valid !== true ||
    (finalization.outcome === "abstained") !== (finalization.fallback !== null)
  ) {
    throw new AssessmentError("conflicting_duplicate");
  }
}

async function completeGradingOperation(
  client: PoolClient,
  finalization: ShortAnswerFinalization,
): Promise<void> {
  if (finalization.outcome === "abstained") {
    await client.query(
      `UPDATE assessment_session_question
       SET presented_at = now()
       WHERE owner_scope_id = $1
         AND operation_idempotency_key = $2
         AND presentation_kind = 'fallback'
         AND presented_at IS NULL`,
      [finalization.ownerScopeId, finalization.idempotencyKey],
    );
  } else {
    await client.query(
      `DELETE FROM assessment_session_question
       WHERE owner_scope_id = $1
         AND operation_idempotency_key = $2
         AND presentation_kind = 'fallback'
         AND presented_at IS NULL`,
      [finalization.ownerScopeId, finalization.idempotencyKey],
    );
  }
  const completed = await client.query<{ idempotency_key: string }>(
    `UPDATE assessment_grading_operation
     SET status = 'finalized', claim_token = NULL, lease_expires_at = NULL,
         finalized_at = now()
     WHERE owner_scope_id = $1
       AND idempotency_key = $2
       AND claim_token = $3
       AND status = 'processing'
     RETURNING idempotency_key`,
    [
      finalization.ownerScopeId,
      finalization.idempotencyKey,
      finalization.claimToken,
    ],
  );
  if (completed.rows[0] === undefined) {
    throw new AssessmentError("conflicting_duplicate");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

async function insertEvidence(
  client: PoolClient,
  finalization: ShortAnswerFinalization | ReplacementFinalization,
  createdAt: string,
  evidence: readonly AssessmentEvidenceCandidate[],
  replacementForAttemptId: string | null,
): Promise<void> {
  for (const candidate of evidence) {
    const reason =
      candidate.judgmentKind === "unanswerable" ? candidate.reason : null;
    await client.query(
      `INSERT INTO attempt_concept_evidence
         (owner_scope_id, attempt_id, concept_id, score, rubric_band,
          grader_confidence, rationale_ref, knowledge_algorithm_version,
          eligible_for_mastery, judgment_kind, grading_method, rubric_id,
          rubric_version, grading_policy_version, rating_mapping_version,
          knowledge_configuration_id, ineligibility_reason, fsrs_rating,
          replacement_for_attempt_id, attempt_created_at, attempt_user_id,
          attempt_outcome, unanswerable_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        finalization.ownerScopeId,
        finalization.attemptId,
        candidate.conceptId,
        candidate.score,
        candidate.rubricBand,
        candidate.graderConfidence,
        candidate.rationaleRef,
        KNOWLEDGE_ALGORITHM_VERSION,
        candidate.eligibleForMastery,
        candidate.judgmentKind,
        candidate.gradingMethod,
        candidate.rubricId,
        candidate.rubricVersion,
        finalization.policy.gradingPolicyVersion,
        finalization.policy.ratingMappingVersion,
        KNOWLEDGE_CONFIGURATION_ID,
        candidate.ineligibilityReason,
        candidate.fsrsRating,
        replacementForAttemptId,
        createdAt,
        finalization.userId,
        "outcome" in finalization ? finalization.outcome : "graded",
        reason,
      ],
    );
  }
}

async function insertReplacementBundle(
  client: PoolClient,
  finalization: ShortAnswerFinalization,
  bundle: NonNullable<ShortAnswerFinalization["fallback"]>,
): Promise<void> {
  if (
    bundle.originalAttemptId !== finalization.attemptId ||
    finalization.outcome !== "abstained"
  ) {
    throw new AssessmentError("invalid_result");
  }
  const conceptIds = bundle.items
    .map((item) => item.conceptId)
    .sort(compareAscii);
  await client.query(
    `INSERT INTO assessment_replacement_bundle
       (owner_scope_id, id, original_attempt_id, grading_policy_version,
        bundle_version, concept_set_digest)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      finalization.ownerScopeId,
      bundle.id,
      finalization.attemptId,
      bundle.policyVersion,
      bundle.version,
      sha256(canonicalJson(conceptIds)),
    ],
  );
  for (const item of bundle.items) {
    await assertSnapshotReplacement(client, finalization, item);
    const snapshotDigest = sha256(canonicalJson(item.question));
    await client.query(
      `INSERT INTO assessment_replacement_item
         (owner_scope_id, id, bundle_id, concept_id, quiz_item_id, rubric_id,
          rubric_version, normalized_prompt_hash, course_id, difficulty,
          prompt, response_options, keyed_answer, source_spans,
          snapshot_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
               $13::jsonb, $14::jsonb, $15)`,
      [
        finalization.ownerScopeId,
        item.id,
        bundle.id,
        item.conceptId,
        item.question.id,
        item.question.rubricId,
        item.question.rubricVersion,
        item.question.normalizedPromptHash,
        item.question.courseId,
        item.question.difficulty,
        item.question.prompt,
        JSON.stringify(item.question.responseOptions),
        JSON.stringify(item.question.keyedAnswer),
        JSON.stringify(item.question.sourceSpans),
        snapshotDigest,
      ],
    );
  }
}

async function assertSnapshotReplacement(
  client: PoolClient,
  finalization: ShortAnswerFinalization,
  item: NonNullable<ShortAnswerFinalization["fallback"]>["items"][number],
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM assessment_grading_operation AS operation,
            jsonb_array_elements(
              operation.authorized_snapshot -> 'fallbackCandidates'
            ) AS candidate
       WHERE operation.owner_scope_id = $1
         AND operation.idempotency_key = $2
         AND operation.claim_token = $3
         AND candidate = $4::jsonb
     ) AS present`,
    [
      finalization.ownerScopeId,
      finalization.idempotencyKey,
      finalization.claimToken,
      JSON.stringify(item.question),
    ],
  );
  if (result.rows[0]?.present !== true) {
    throw new AssessmentError("fallback_unavailable");
  }
}

async function insertFinalization(
  client: PoolClient,
  finalization: {
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly learnerMessage: string;
    readonly outcome: "abstained" | "graded";
    readonly ownerScopeId: string;
    readonly policy: ShortAnswerFinalization["policy"];
    readonly userId: string;
  },
  digest: string,
  kind: "keyed_mc_replacement" | "short_answer",
): Promise<void> {
  await client.query(
    `INSERT INTO assessment_finalization
       (owner_scope_id, idempotency_key, attempt_id, user_id, attempt_outcome,
        finalization_kind, grading_policy_version, rating_mapping_version,
        confidence_threshold, calibration_evidence_id, policy_binding,
        policy_binding_digest, learner_message, request_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
             $13, $14)`,
    [
      finalization.ownerScopeId,
      finalization.idempotencyKey,
      finalization.attemptId,
      finalization.userId,
      finalization.outcome,
      kind,
      finalization.policy.gradingPolicyVersion,
      finalization.policy.ratingMappingVersion,
      finalization.policy.confidenceThreshold,
      finalization.policy.calibrationEvidenceId,
      JSON.stringify(finalization.policy.expectedModelProvenance),
      policyBindingDigest(finalization.policy),
      finalization.learnerMessage,
      digest,
    ],
  );
}

async function ensurePolicyBinding(
  client: PoolClient,
  policy: ShortAnswerFinalization["policy"],
): Promise<void> {
  const bindingDigest = policyBindingDigest(policy);
  await client.query(
    `INSERT INTO grading_policy_binding
       (grading_policy_version, rating_mapping_version, confidence_threshold,
        calibration_evidence_id, expected_model_provenance, binding_digest)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT DO NOTHING`,
    [
      policy.gradingPolicyVersion,
      policy.ratingMappingVersion,
      policy.confidenceThreshold,
      policy.calibrationEvidenceId,
      JSON.stringify(policy.expectedModelProvenance),
      bindingDigest,
    ],
  );
  const current = await client.query<{ matches: boolean }>(
    `SELECT (
       rating_mapping_version = $2
       AND confidence_threshold = $3
       AND calibration_evidence_id = $4
       AND expected_model_provenance = $5::jsonb
       AND binding_digest = $6
     ) AS matches
     FROM grading_policy_binding
     WHERE grading_policy_version = $1`,
    [
      policy.gradingPolicyVersion,
      policy.ratingMappingVersion,
      policy.confidenceThreshold,
      policy.calibrationEvidenceId,
      JSON.stringify(policy.expectedModelProvenance),
      bindingDigest,
    ],
  );
  if (current.rows[0]?.matches !== true) {
    throw new AssessmentError("invalid_configuration");
  }
}

function policyBindingDigest(
  policy: ShortAnswerFinalization["policy"],
): string {
  return sha256(canonicalJson(policy));
}

async function loadAndVerifyReplay(
  client: PoolClient,
  finalization: ShortAnswerFinalization | ReplacementFinalization,
  digest: string,
): Promise<AssessmentFinalizationView | null> {
  const current = await client.query<FinalizationRow>(
    `SELECT finalization.attempt_id, finalization.attempt_outcome,
            finalization.learner_message, finalization.request_digest,
            attempt.replacement_for_attempt_id
     FROM assessment_finalization AS finalization
     JOIN attempt
       ON attempt.owner_scope_id = finalization.owner_scope_id
      AND attempt.id = finalization.attempt_id
     WHERE finalization.owner_scope_id = $1
       AND finalization.idempotency_key = $2
       AND finalization.user_id = $3`,
    [
      finalization.ownerScopeId,
      finalization.idempotencyKey,
      finalization.userId,
    ],
  );
  if (current.rows[0] === undefined) return null;
  if (current.rows[0].request_digest !== digest) {
    throw new AssessmentError("conflicting_duplicate");
  }
  return loadFinalizationView(
    client,
    finalization.ownerScopeId,
    finalization.userId,
    finalization.idempotencyKey,
    "replayed",
  );
}

async function loadFinalizationView(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  idempotencyKey: string,
  status: "created" | "replayed",
): Promise<AssessmentFinalizationView | null> {
  const finalization = await client.query<FinalizationRow>(
    `SELECT finalization.attempt_id, finalization.attempt_outcome,
            finalization.learner_message, attempt.replacement_for_attempt_id,
            finalization.request_digest
     FROM assessment_finalization AS finalization
     JOIN attempt
       ON attempt.owner_scope_id = finalization.owner_scope_id
      AND attempt.id = finalization.attempt_id
     WHERE finalization.owner_scope_id = $1
       AND finalization.idempotency_key = $2
       AND finalization.user_id = $3`,
    [ownerScopeId, idempotencyKey, userId],
  );
  const row = finalization.rows[0];
  if (row === undefined) return null;
  const evidence = await client.query<EvidenceRow>(
    `SELECT concept_id, eligible_for_mastery, fsrs_rating,
            grader_confidence::text, grading_method, ineligibility_reason,
            judgment_kind, rationale_ref, rubric_band, rubric_id,
            rubric_version, score::text, unanswerable_reason
     FROM attempt_concept_evidence
     WHERE owner_scope_id = $1 AND attempt_id = $2
     ORDER BY concept_id`,
    [ownerScopeId, row.attempt_id],
  );
  const bundle = await client.query<{ id: string }>(
    `SELECT id
     FROM assessment_replacement_bundle
     WHERE owner_scope_id = $1 AND original_attempt_id = $2`,
    [ownerScopeId, row.attempt_id],
  );
  return {
    attemptId: row.attempt_id,
    evidence: evidence.rows.map(mapEvidence),
    fallback:
      bundle.rows[0] === undefined
        ? null
        : await loadReplacementBundle(
            client,
            ownerScopeId,
            userId,
            bundle.rows[0].id,
          ),
    learnerMessage: row.learner_message,
    outcome: row.attempt_outcome,
    replacementForAttemptId: row.replacement_for_attempt_id,
    requestDigest: row.request_digest,
    status,
  };
}

async function loadReplacementBundle(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  bundleId: string,
): Promise<ReplacementBundle | null> {
  const bundle = await client.query<{
    bundle_version: "mc-replacement-bundle-v1";
    grading_policy_version: "grading-policy-v1";
    id: string;
    original_attempt_id: string;
  }>(
    `SELECT bundle.id, bundle.original_attempt_id,
            bundle.grading_policy_version, bundle.bundle_version
     FROM assessment_replacement_bundle AS bundle
     JOIN attempt AS original
       ON original.owner_scope_id = bundle.owner_scope_id
      AND original.id = bundle.original_attempt_id
     WHERE bundle.owner_scope_id = $1 AND bundle.id = $2
       AND original.user_id = $3`,
    [ownerScopeId, bundleId, userId],
  );
  const row = bundle.rows[0];
  if (row === undefined) return null;
  const items = await client.query<ReplacementItemRow>(
    `SELECT item.id, item.concept_id, item.quiz_item_id, item.rubric_id,
            item.rubric_version, item.normalized_prompt_hash,
            item.course_id, item.difficulty, item.prompt,
            item.response_options, item.source_spans
     FROM assessment_replacement_item AS item
     WHERE item.owner_scope_id = $1 AND item.bundle_id = $2
     ORDER BY item.concept_id`,
    [ownerScopeId, bundleId],
  );
  return {
    id: row.id,
    items: items.rows.map((item) => ({
      conceptId: item.concept_id,
      id: item.id,
      question: {
        conceptIds: [item.concept_id],
        courseId: item.course_id,
        difficulty: item.difficulty,
        id: item.quiz_item_id,
        itemType: "multiple_choice",
        normalizedPromptHash: item.normalized_prompt_hash,
        prompt: item.prompt,
        responseOptions: item.response_options,
        rubricId: item.rubric_id,
        rubricVersion: item.rubric_version,
        sourceSpans: item.source_spans,
      } satisfies LearnerMultipleChoiceQuestion,
    })),
    originalAttemptId: row.original_attempt_id,
    policyVersion: row.grading_policy_version,
    version: row.bundle_version,
  };
}

function mapEvidence(row: EvidenceRow): AssessmentEvidenceCandidate {
  const common = {
    conceptId: row.concept_id,
    eligibleForMastery: row.eligible_for_mastery,
    fsrsRating: row.fsrs_rating,
    graderConfidence: row.grader_confidence,
    gradingMethod: row.grading_method,
    ineligibilityReason: row.ineligibility_reason,
    judgmentKind: row.judgment_kind,
    rationaleRef: row.rationale_ref,
    rubricBand: row.rubric_band,
    rubricId: row.rubric_id,
    rubricVersion: row.rubric_version,
    score: row.score,
  };
  return (
    row.judgment_kind === "unanswerable"
      ? { ...common, reason: row.unanswerable_reason }
      : common
  ) as AssessmentEvidenceCandidate;
}

async function setScopeContext(
  client: PoolClient,
  authorization: {
    readonly actorId: string;
    readonly authorizationId: string;
    readonly ownerScopeId: string;
  },
): Promise<void> {
  if (
    authorization.actorId.length === 0 ||
    authorization.authorizationId.length === 0 ||
    authorization.ownerScopeId.length === 0
  ) {
    throw new AssessmentError("authorization_denied");
  }
  await client.query(
    `SELECT set_config('reflo.actor_id', $1, true),
            set_config('reflo.owner_scope_id', $2, true)`,
    [authorization.actorId, authorization.ownerScopeId],
  );
}

function assertAuthorization(
  authorization: {
    readonly actorId: string;
    readonly ownerScopeId: string;
  },
  finalization: {
    readonly ownerScopeId: string;
    readonly userId: string;
  },
): void {
  if (
    authorization.actorId !== finalization.userId ||
    authorization.ownerScopeId !== finalization.ownerScopeId
  ) {
    throw new AssessmentError("authorization_denied");
  }
}

function requiredReplay(
  value: AssessmentFinalizationView | null,
): AssessmentFinalizationView {
  if (value === null) throw new AssessmentError("conflicting_duplicate");
  return value;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
