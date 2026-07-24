import {
  AssessmentError,
  type AssessmentEvidenceCandidate,
  type AssessmentFinalizationView,
  type AssessmentRepositoryPort,
  type KeyedMultipleChoiceQuestion,
  type ReplacementBundle,
  type ReplacementFinalization,
  type ReplacementItem,
  type ShortAnswerFinalization,
} from "@reflo/assessment";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
} from "@reflo/knowledge-model";
import { canonicalJson, sha256 } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface FinalizationRow extends Record<string, unknown> {
  attempt_id: string;
  attempt_outcome: "abstained" | "graded";
  learner_message: string;
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
  keyed_answer: string;
  normalized_prompt_hash: string;
  prompt: string;
  quiz_item_id: string;
  response_options: readonly string[];
  rubric_id: string;
  rubric_version: string;
  source_spans: readonly { readonly id: string; readonly text: string }[];
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
      await assertQuestionSession(
        client,
        finalization.ownerScopeId,
        finalization.userId,
        finalization.sessionId,
        finalization.questionId,
        "short_answer",
      );
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
      }>(
        `SELECT bundle.original_attempt_id, item.quiz_item_id
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
      await assertQuestionSession(
        client,
        finalization.ownerScopeId,
        finalization.userId,
        finalization.sessionId,
        source.quiz_item_id,
        "multiple_choice",
      );
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
  bundle: ReplacementBundle,
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
    await assertReplacementQuestion(client, finalization, item);
    await client.query(
      `INSERT INTO assessment_replacement_item
         (owner_scope_id, id, bundle_id, concept_id, quiz_item_id, rubric_id,
          rubric_version, normalized_prompt_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        finalization.ownerScopeId,
        item.id,
        bundle.id,
        item.conceptId,
        item.question.id,
        item.question.rubricId,
        item.question.rubricVersion,
        item.question.normalizedPromptHash,
      ],
    );
  }
}

async function assertReplacementQuestion(
  client: PoolClient,
  finalization: ShortAnswerFinalization,
  item: ReplacementItem,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM quiz_item AS replacement
       JOIN quiz_item_concept AS link
         ON link.owner_scope_id = replacement.owner_scope_id
        AND link.quiz_item_id = replacement.id
       JOIN quiz_item AS original
         ON original.owner_scope_id = replacement.owner_scope_id
        AND original.id = $4
       WHERE replacement.owner_scope_id = $1
         AND replacement.id = $2
         AND link.concept_id = $3
         AND replacement.course_id = original.course_id
         AND replacement.item_type = 'multiple_choice'
         AND replacement.normalized_prompt_hash = $5
         AND replacement.normalized_prompt_hash
             IS DISTINCT FROM original.normalized_prompt_hash
         AND jsonb_typeof(replacement.response_options) = 'array'
         AND replacement.keyed_answer IS NOT NULL
         AND (
           SELECT count(*)
           FROM quiz_item_concept AS all_links
           WHERE all_links.owner_scope_id = replacement.owner_scope_id
             AND all_links.quiz_item_id = replacement.id
         ) = 1
         AND EXISTS (
           SELECT 1
           FROM quiz_item_source_span AS source_link
           WHERE source_link.owner_scope_id = replacement.owner_scope_id
             AND source_link.quiz_item_id = replacement.id
         )
     ) AS present`,
    [
      finalization.ownerScopeId,
      item.question.id,
      item.conceptId,
      finalization.questionId,
      item.question.normalizedPromptHash,
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
    `SELECT attempt_id, attempt_outcome, learner_message, request_digest
     FROM assessment_finalization
     WHERE owner_scope_id = $1 AND idempotency_key = $2 AND user_id = $3`,
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
    `SELECT attempt_id, attempt_outcome, learner_message, request_digest
     FROM assessment_finalization
     WHERE owner_scope_id = $1 AND idempotency_key = $2 AND user_id = $3`,
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
            quiz.course_id, quiz.difficulty, quiz.prompt,
            quiz.keyed_answer #>> '{}' AS keyed_answer,
            quiz.response_options AS response_options,
            (
              SELECT jsonb_agg(
                jsonb_build_object('id', span.id, 'text', span.canonical_text)
                ORDER BY span.id
              )
              FROM quiz_item_source_span AS link
              JOIN source_span AS span
                ON span.owner_scope_id = link.owner_scope_id
               AND span.id = link.source_span_id
              WHERE link.owner_scope_id = quiz.owner_scope_id
                AND link.quiz_item_id = quiz.id
            ) AS source_spans
     FROM assessment_replacement_item AS item
     JOIN quiz_item AS quiz
       ON quiz.owner_scope_id = item.owner_scope_id
      AND quiz.id = item.quiz_item_id
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
        keyedAnswer: item.keyed_answer,
        normalizedPromptHash: item.normalized_prompt_hash,
        prompt: item.prompt,
        responseOptions: item.response_options,
        rubricId: item.rubric_id,
        rubricVersion: item.rubric_version,
        sourceSpans: item.source_spans,
      } satisfies KeyedMultipleChoiceQuestion,
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

async function assertQuestionSession(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  sessionId: string,
  questionId: string,
  itemType: "multiple_choice" | "short_answer",
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM study_session AS session
       JOIN quiz_item AS question
         ON question.owner_scope_id = session.owner_scope_id
        AND question.course_id = session.course_id
       WHERE session.owner_scope_id = $1
         AND session.id = $2
         AND session.user_id = $3
         AND session.status = 'active'
         AND question.id = $4
         AND question.item_type = $5
     ) AS present`,
    [ownerScopeId, sessionId, userId, questionId, itemType],
  );
  if (result.rows[0]?.present !== true) {
    throw new AssessmentError("authorization_denied");
  }
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
