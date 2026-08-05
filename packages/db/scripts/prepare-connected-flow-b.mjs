#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLiteLlmDevAdapters } from "@reflo/model-router/litellm";
import { stableUuid } from "@reflo/retrieval";
import pg from "pg";

const operatorProfile = operatorFixtureProfile();
const fixtureId = (kind, fallback) =>
  operatorProfile === null
    ? fallback
    : stableUuid({
        kind,
        ownerScopeId: operatorProfile.scope,
        profile: "operator-hosted-connected-flow-b-v1",
      });
const IDS = Object.freeze({
  actor: operatorProfile?.actor ?? "16400000-0000-4000-8000-000000000001",
  asset: fixtureId("asset", "16400000-0000-4000-8000-000000000002"),
  chapter: fixtureId("chapter", "16400000-0000-4000-8000-000000000003"),
  concept: fixtureId("concept", "16400000-0000-4000-8000-000000000004"),
  course: operatorProfile?.course ?? "16400000-0000-4000-8000-000000000005",
  curriculum: fixtureId("curriculum", "16400000-0000-4000-8000-000000000006"),
  document: fixtureId("document", "16400000-0000-4000-8000-000000000007"),
  emailChannel: fixtureId(
    "email-channel",
    "16400000-0000-4000-8000-000000000020",
  ),
  lessonOperation: fixtureId(
    "lesson-operation",
    "16400000-0000-4000-8000-000000000008",
  ),
  membership: fixtureId("membership", "16400000-0000-4000-8000-000000000009"),
  scope: operatorProfile?.scope ?? "16400000-0000-4000-8000-00000000000a",
  span: fixtureId("span", "16400000-0000-4000-8000-00000000000b"),
  telegramChannel: fixtureId(
    "telegram-channel",
    "16400000-0000-4000-8000-000000000021",
  ),
});
const LESSON_CONTENT = [
  "# Evidence and retention",
  "",
  "A study explanation can make an idea visible, but exposure is not proof",
  "that the learner can retrieve it. Reflo updates mastery only after eligible",
  "assessment evidence is persisted. A distinct check after a different",
  "explanation supplies new evidence without counting the lesson view itself.",
].join("\n");
const SPAN_TEXT =
  "Retention improves when a learner retrieves knowledge in a distinct assessment; viewing a lesson alone is not evidence.";

const databaseUrl = required("DATABASE_URL");
const vectorDatabaseUrl = required("REFLO_VECTOR_DATABASE_URL");
const artifactRoot = absolute("REFLO_CONNECTED_DEMO_ARTIFACT_ROOT");
const staffEmail = email(required("REFLO_FLOW_B_STAFF_EMAIL"));
const lookupKey = base64Key("REFLO_AUTH_LOOKUP_KEY");
const destinationLookupKey = base64Key("REFLO_DEMO_DESTINATION_LOOKUP_KEY");
const liteLlm = createLiteLlmDevAdapters(process.env);
const lookupDigest = createHmac("sha256", lookupKey)
  .update(`email:${staffEmail.toLowerCase()}`)
  .digest("hex");
const lessonHash = sha256(LESSON_CONTENT);
const objectKey =
  `owners/${IDS.scope}/courses/${IDS.course}/assets/${IDS.asset}/` +
  `generations/${IDS.lessonOperation}/payload.md`;

await ensureArtifact();
const client = new pg.Client({ connectionString: databaseUrl });
const vector = new pg.Client({ connectionString: vectorDatabaseUrl });
try {
  await Promise.all([client.connect(), vector.connect()]);
  await client.query("BEGIN");
  await seedIdentityAndSource(client);
  const generation = await ensureEmbeddingGeneration(client, vector);
  await seedCurriculumAndLesson(client, generation.id);
  await ensureFlowBQuestions(client);
  await client.query("COMMIT");

  const vectorCount = await vector.query(
    `SELECT count(*)::integer AS count
     FROM reflo_source_span_embedding_litellm_dev_v1
     WHERE owner_scope_id = $1
       AND source_document_id = $2
       AND embedding_generation_id = $3
       AND embedding_profile_version = $4`,
    [IDS.scope, IDS.document, generation.id, generation.profileVersion],
  );
  if (vectorCount.rows[0]?.count !== 1) {
    throw new Error("synthetic local vector generation is unavailable");
  }
  console.info(
    JSON.stringify({
      contractVersion: "connected-flow-b-fixture-v1",
      courseId: IDS.course,
      embeddingProfileVersion: generation.profileVersion,
      lessonArtifactVerified: true,
      outcome: "ready",
      vectorCount: 1,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await Promise.allSettled([client.end(), vector.end()]);
}

async function seedIdentityAndSource(client) {
  const collision = await client.query(
    `SELECT id
     FROM app_user
     WHERE email_lookup_digest = decode($1, 'hex')
       AND id <> $2`,
    [lookupDigest, IDS.actor],
  );
  if (collision.rowCount !== 0) {
    throw new Error(
      "configured staff identity belongs to another local fixture",
    );
  }
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode($2, 'hex'), decode($3, 'hex'))
     ON CONFLICT (id) DO UPDATE
       SET email_lookup_digest = EXCLUDED.email_lookup_digest`,
    [
      IDS.actor,
      lookupDigest,
      Buffer.from("synthetic-flow-b-staff", "utf8").toString("hex"),
    ],
  );
  await client.query(
    `INSERT INTO owner_scope (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.scope],
  );
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_scope_id, user_id) DO NOTHING`,
    [IDS.membership, IDS.scope, IDS.actor],
  );
  for (const [id, provider, destination] of [
    [IDS.emailChannel, "email", required("REFLO_DEMO_EMAIL_DESTINATION")],
    [
      IDS.telegramChannel,
      "telegram",
      required("REFLO_DEMO_TELEGRAM_DESTINATION"),
    ],
  ]) {
    const digest = createHmac("sha256", destinationLookupKey)
      .update(destination)
      .digest("hex");
    await client.query(
      `INSERT INTO channel_identity
         (id, owner_scope_id, user_id, provider, encrypted_external_id,
          external_id_lookup_digest, verified_at, identity_class)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'), decode($6, 'hex'), now(),
               'demo_staff')
       ON CONFLICT (id) DO UPDATE
         SET external_id_lookup_digest = EXCLUDED.external_id_lookup_digest,
             revoked_at = NULL,
             verified_at = EXCLUDED.verified_at`,
      [
        id,
        IDS.scope,
        IDS.actor,
        provider,
        Buffer.from(`synthetic-${provider}-destination`, "utf8").toString(
          "hex",
        ),
        digest,
      ],
    );
  }
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type, byte_size,
        parse_status)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, 'parsed')
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      IDS.document,
      IDS.scope,
      `owners/${IDS.scope}/sources/${IDS.document}/synthetic.pdf`,
      `sha256:${sha256(SPAN_TEXT)}`,
      Buffer.byteLength(SPAN_TEXT),
    ],
  );
  const embeddingInput = `Evidence and retention\n${SPAN_TEXT}`;
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        section_path, canonical_start, canonical_end, parser_version,
        chunker_version, tokenizer_version, contract_version, chunk_order,
        native_mappings, embedding_input, embedding_input_hash,
        embedding_input_profile_version)
     VALUES ($1, $2, $3, $4, $5, ARRAY['Evidence and retention'], 0, $6,
             'synthetic-flow-b-parser-v1', 'chunk-v1',
             'reflo-unicode-tokenizer-v1', 'source-span-v1', 0, '[]'::jsonb,
             $7, $8, 'embedding-input-v1')
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      IDS.span,
      IDS.scope,
      IDS.document,
      SPAN_TEXT,
      sha256(SPAN_TEXT),
      SPAN_TEXT.length,
      embeddingInput,
      sha256(embeddingInput),
    ],
  );
  await client.query(
    `INSERT INTO course
     (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Adaptive Learning Foundations', 'ready')
     ON CONFLICT (owner_scope_id, id) DO UPDATE
       SET title = EXCLUDED.title`,
    [IDS.course, IDS.scope, IDS.document],
  );
}

async function seedCurriculumAndLesson(client, embeddingGenerationId) {
  await client.query(
    `INSERT INTO curriculum_generation
       (id, owner_scope_id, course_id, source_document_id,
        embedding_generation_id, generation_version, result_hash,
        model_provenance, structure, status, activated_at)
     VALUES ($1, $2, $3, $4, $5, 'curriculum-v1', $6,
             '{"fixture":"synthetic-connected-flow-b-v1"}'::jsonb,
             $7::jsonb, 'active', now())
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      IDS.curriculum,
      IDS.scope,
      IDS.course,
      IDS.document,
      embeddingGenerationId,
      sha256("synthetic-connected-flow-b-curriculum-v1"),
      JSON.stringify({
        chapters: [
          {
            concepts: [
              {
                key: "evidence-and-retention",
                name: "Evidence and retention",
                prerequisiteKeys: [],
                sourceSpanIds: [IDS.span],
              },
            ],
            sourceSpanIds: [IDS.span],
            title: "Adaptive learning",
          },
        ],
      }),
    ],
  );
  await client.query(
    `UPDATE course
     SET active_curriculum_generation_id = $1
     WHERE owner_scope_id = $2 AND id = $3`,
    [IDS.curriculum, IDS.scope, IDS.course],
  );
  await client.query(
    `INSERT INTO chapter
       (id, owner_scope_id, course_id, chapter_order, title,
        generation_status, curriculum_generation_id)
     VALUES ($1, $2, $3, 1, 'Adaptive learning', 'ready', $4)
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [IDS.chapter, IDS.scope, IDS.course, IDS.curriculum],
  );
  await client.query(
    `INSERT INTO chapter_source_span
       (owner_scope_id, chapter_id, source_span_id, span_order)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT DO NOTHING`,
    [IDS.scope, IDS.chapter, IDS.span],
  );
  await client.query(
    `INSERT INTO concept
       (id, owner_scope_id, chapter_id, name, generation_version,
        curriculum_generation_id, concept_key, concept_order)
     VALUES ($1, $2, $3, 'Evidence and retention', 'curriculum-v1', $4,
             'evidence-and-retention', 0)
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [IDS.concept, IDS.scope, IDS.chapter, IDS.curriculum],
  );
  await client.query(
    `INSERT INTO concept_source_span
       (owner_scope_id, concept_id, source_span_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [IDS.scope, IDS.concept, IDS.span],
  );
  await client.query(
    `INSERT INTO activation_generation_operation
       (id, owner_scope_id, course_id, curriculum_generation_id,
        artifact_kind, chapter_id, concept_id, generation_version,
        idempotency_key, priority, status, attempt_count, artifact_id,
        completed_at)
     VALUES ($1, $2, $3, $4, 'first_text_lesson', $5, $6,
             'activation-generation-v1', $7, 1, 'succeeded', 1, $8, now())
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      IDS.lessonOperation,
      IDS.scope,
      IDS.course,
      IDS.curriculum,
      IDS.chapter,
      IDS.concept,
      `dev/content.activation.generate/v1/${IDS.lessonOperation}`,
      IDS.asset,
    ],
  );
  await client.query(
    `INSERT INTO asset
       (id, owner_scope_id, course_id, chapter_id, concept_id, asset_type,
        object_key, model_id, prompt_id, generation_version, strategy_tag,
        status, generation_operation_id, model_provenance, content_hash,
        content_type, byte_size, etag)
     VALUES ($1, $2, $3, $4, $5, 'text', $6, 'synthetic-fixture',
             'lesson-text', 'activation-generation-v1', 'worked-example-v1',
             'ready', $7, '{"task":"lesson.text.v1","fixture":true}'::jsonb,
             $8, 'text/markdown; charset=utf-8', $9, $8)
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      IDS.asset,
      IDS.scope,
      IDS.course,
      IDS.chapter,
      IDS.concept,
      objectKey,
      IDS.lessonOperation,
      lessonHash,
      Buffer.byteLength(LESSON_CONTENT),
    ],
  );
  await client.query(
    `INSERT INTO asset_source_span
       (owner_scope_id, asset_id, source_span_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [IDS.scope, IDS.asset, IDS.span],
  );
}

async function ensureFlowBQuestions(client) {
  const questions = [
    [
      fixtureId("question-1", "16400000-0000-4000-8000-000000000010"),
      "multiple_choice",
      "Which activity provides eligible evidence for a mastery update?",
    ],
    [
      fixtureId("question-2", "16400000-0000-4000-8000-000000000011"),
      "multiple_choice",
      "When should Reflo update a learner's mastery estimate?",
    ],
    [
      fixtureId("question-3", "16400000-0000-4000-8000-000000000012"),
      "multiple_choice",
      "What should carry more weight in the Knowledge Map?",
    ],
    [
      fixtureId("question-4", "16400000-0000-4000-8000-000000000013"),
      "multiple_choice",
      "Which event is evidence of retrieval rather than exposure?",
    ],
    [
      fixtureId("question-5", "16400000-0000-4000-8000-000000000014"),
      "short_answer",
      "Why doesn't viewing a lesson immediately raise mastery?",
    ],
    [
      fixtureId("question-6", "16400000-0000-4000-8000-000000000015"),
      "short_answer",
      "What kind of evidence should update mastery after a new explanation?",
    ],
  ];
  for (const [index, [id, itemType, prompt]] of questions.entries()) {
    const rubric =
      itemType === "short_answer"
        ? [
            {
              conceptId: IDS.concept,
              materialContradictions: [],
              requiredCriteria: ["Explains evidence-backed retention"],
              rubricId: `connected-flow-b-rubric-${index + 1}`,
              rubricVersion: "1",
              sourceSpanIds: [IDS.span],
            },
          ]
        : null;
    await client.query(
      `INSERT INTO quiz_item
         (id, owner_scope_id, course_id, item_type, difficulty, prompt,
          keyed_answer, rubric, version, item_order, normalized_prompt_hash,
          response_options)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $4 = 'multiple_choice'
                 THEN to_jsonb('Eligible assessment evidence'::text)
                 ELSE 'null'::jsonb
               END,
               $7::jsonb, 'connected-flow-b-fixture-v1', $8, $9,
               CASE WHEN $4 = 'multiple_choice'
                 THEN '["Eligible assessment evidence","Lesson exposure"]'::jsonb
                 ELSE NULL
               END)
       ON CONFLICT (id) DO UPDATE
         SET prompt = EXCLUDED.prompt,
             normalized_prompt_hash = EXCLUDED.normalized_prompt_hash`,
      [
        id,
        IDS.scope,
        IDS.course,
        itemType,
        (index % 5) + 1,
        prompt,
        JSON.stringify(rubric),
        index,
        sha256(prompt),
      ],
    );
    await client.query(
      `INSERT INTO quiz_item_concept
         (owner_scope_id, quiz_item_id, concept_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [IDS.scope, id, IDS.concept],
    );
    await client.query(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [IDS.scope, id, IDS.span],
    );
  }
}

async function ensureEmbeddingGeneration(client, vector) {
  const profileVersion = liteLlm.embeddingProfileVersion;
  const embeddingModel = required("REFLO_LITELLM_EMBEDDING_MODEL");
  const endpoint = new URL(
    "v1/embeddings",
    required("REFLO_LITELLM_BASE_URL"),
  ).toString();
  const active = await client.query(
    `SELECT generation.id
     FROM source_document AS source
     JOIN source_embedding_generation AS generation
       ON generation.owner_scope_id = source.owner_scope_id
      AND generation.id = source.active_embedding_generation_id
     WHERE source.owner_scope_id = $1
       AND source.id = $2
       AND generation.status = 'active'
       AND generation.profile_version = $3
       AND generation.adapter_version = 'litellm-openai-compatible-dev-v1'
       AND generation.effective_model = $4
       AND generation.effective_model_version = $3
       AND generation.provider_identifier = 'litellm-development'
       AND generation.region = 'local-development'
       AND generation.endpoint = $5`,
    [IDS.scope, IDS.document, profileVersion, embeddingModel, endpoint],
  );
  if (active.rows[0]?.id !== undefined) {
    return { id: active.rows[0].id, profileVersion };
  }

  const span = await client.query(
    `SELECT embedding_input, embedding_input_hash
     FROM source_span
     WHERE owner_scope_id = $1 AND id = $2`,
    [IDS.scope, IDS.span],
  );
  const source = span.rows[0];
  if (source === undefined) {
    throw new Error("synthetic source span is unavailable for embedding");
  }
  const requestBody = {
    dimensions: 1_024,
    encoding_format: "float",
    input: [source.embedding_input],
    model: embeddingModel,
  };
  const response = await globalThis.fetch(endpoint, {
    body: JSON.stringify(requestBody),
    headers: {
      authorization: `Bearer ${required("REFLO_LITELLM_API_KEY")}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  const embedding = payload?.data?.[0]?.embedding;
  if (
    !response.ok ||
    !Array.isArray(embedding) ||
    embedding.length !== 1_024 ||
    embedding.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    throw new Error("deterministic embedding fixture returned invalid vectors");
  }
  const providerRequestId =
    response.headers.get("x-request-id") ??
    (typeof payload?.id === "string" ? payload.id : undefined);
  const providerRequestIds =
    providerRequestId === undefined ? [] : [providerRequestId];
  const generationId = stableUuid({
    adapterVersion: "litellm-openai-compatible-dev-v1",
    effectiveModel: embeddingModel,
    effectiveModelVersion: profileVersion,
    endpoint,
    inputHashes: [source.embedding_input_hash],
    profileVersion,
    providerIdentifier: "litellm-development",
    providerRequestIds,
    region: "local-development",
    sourceDocumentId: IDS.document,
  });
  await client.query(
    `INSERT INTO source_embedding_generation
       (id, owner_scope_id, source_document_id, profile_version, dimensions,
        input_mode, adapter_version, effective_model,
        effective_model_version, provider_identifier, provider_request_ids,
        region, endpoint, span_count, status)
     VALUES ($1, $2, $3, $4, 1024, 'document',
             'litellm-openai-compatible-dev-v1', $5, $4,
             'litellm-development', $6::jsonb, 'local-development', $7, 1,
             'building')
     ON CONFLICT (owner_scope_id, id) DO NOTHING`,
    [
      generationId,
      IDS.scope,
      IDS.document,
      profileVersion,
      embeddingModel,
      JSON.stringify(providerRequestIds),
      endpoint,
    ],
  );
  await client.query(
    `INSERT INTO source_embedding_generation_span
       (owner_scope_id, embedding_generation_id, source_span_id, span_order,
        embedding_input_hash)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT DO NOTHING`,
    [IDS.scope, generationId, IDS.span, source.embedding_input_hash],
  );
  await vector.query(
    `INSERT INTO reflo_source_span_embedding_litellm_dev_v1
       (owner_scope_id, source_span_id, embedding_generation_id,
        source_document_id, embedding_profile_version, embedding_input_hash,
        dimensions, distance_metric, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, 1024, 'cosine', $7::vector)
     ON CONFLICT (owner_scope_id, source_span_id, embedding_generation_id)
     DO NOTHING`,
    [
      IDS.scope,
      IDS.span,
      generationId,
      IDS.document,
      profileVersion,
      source.embedding_input_hash,
      vectorLiteral(embedding),
    ],
  );
  await client.query(
    `UPDATE source_embedding_generation
     SET status = 'retired'
     WHERE owner_scope_id = $1
       AND source_document_id = $2
       AND status = 'active'
       AND id <> $3`,
    [IDS.scope, IDS.document, generationId],
  );
  await client.query(
    `UPDATE source_embedding_generation
     SET status = 'active', activated_at = COALESCE(activated_at, now())
     WHERE owner_scope_id = $1 AND id = $2`,
    [IDS.scope, generationId],
  );
  await client.query(
    `UPDATE source_document
     SET active_embedding_generation_id = $3
     WHERE owner_scope_id = $1 AND id = $2`,
    [IDS.scope, IDS.document, generationId],
  );
  return { id: generationId, profileVersion };
}

async function ensureArtifact() {
  const target = path.resolve(artifactRoot, objectKey);
  if (!target.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error("synthetic lesson object key escaped its artifact root");
  }
  await mkdir(path.dirname(target), { mode: 0o700, recursive: true });
  await writeFile(target, LESSON_CONTENT, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  });
  const stored = await readFile(target, "utf8");
  if (sha256(stored) !== lessonHash) {
    throw new Error("synthetic lesson artifact hash is inconsistent");
  }
}

function vectorLiteral(vector) {
  return `[${vector.map((value) => String(value)).join(",")}]`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function operatorFixtureProfile() {
  const profile = process.env.REFLO_FLOW_B_FIXTURE_PROFILE?.trim();
  if (profile === undefined || profile === "") return null;
  if (profile !== "operator-hosted-connected-demo-v1") {
    throw new Error("REFLO_FLOW_B_FIXTURE_PROFILE is not allowlisted");
  }
  const actor = requiredUuid("REFLO_DEMO_OPERATOR_USER_ID");
  const scope = requiredUuid("REFLO_DEMO_OPERATOR_OWNER_SCOPE_ID");
  const course = requiredUuid("REFLO_DEMO_SEED_COURSE_ID");
  return { actor, course, scope };
}

function requiredUuid(name) {
  const value = required(name);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function absolute(name) {
  const value = required(name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute`);
  }
  return path.resolve(value);
}

function base64Key(name) {
  const value = required(name);
  const decoded = Buffer.from(value, "base64");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    decoded.byteLength !== 32 ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(`${name} must be a canonical base64 32-byte key`);
  }
  return decoded;
}

function email(value) {
  const normalized = value.toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)
  ) {
    throw new Error("REFLO_FLOW_B_STAFF_EMAIL is invalid");
  }
  return normalized;
}
