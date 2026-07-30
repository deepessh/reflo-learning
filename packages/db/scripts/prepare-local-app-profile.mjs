#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { migrateStrict } from "./strict-migrate.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCAL_API_ROLE = "reflo_api";
const LOCAL_REDRIVE_ROLE = "reflo_redrive";
const LOCAL_RELAY_ROLE = "reflo_relay";
const LOCAL_VECTOR_API_ROLE = "reflo_vector_api";

export function resolveLocalSchemaPaths() {
  const retrievalEntry = fileURLToPath(import.meta.resolve("@reflo/retrieval"));
  const retrievalRoot = path.resolve(path.dirname(retrievalEntry), "..");
  return Object.freeze({
    developmentRds: path.join(
      packageRoot,
      "sql/local-smoke-development-profile.sql",
    ),
    developmentVector: path.join(
      retrievalRoot,
      "sql/20260722000100_litellm_dev_vector_namespace_v1.sql",
    ),
    vector: path.join(
      retrievalRoot,
      "sql/20260721000100_vector_namespace_v1.sql",
    ),
  });
}

export async function prepareLocalApplicationProfile(
  environment = process.env,
) {
  if (environment.REFLO_ENV !== "dev") {
    throw new Error("local application database setup requires REFLO_ENV=dev");
  }
  const databaseUrl = required(environment, "DATABASE_URL");
  const vectorDatabaseUrl = required(environment, "REFLO_VECTOR_DATABASE_URL");
  const apiPassword = requiredMatching(
    environment,
    "REFLO_LOCAL_API_RDS_PASSWORD",
    /^[a-f0-9]{48}$/,
  );
  const paths = resolveLocalSchemaPaths();

  await migrateStrict(databaseUrl);
  await applySql(databaseUrl, paths.developmentRds);
  await provisionLocalApiRole(databaseUrl, apiPassword);
  if (
    environment.REFLO_LOCAL_RELAY_RDS_PASSWORD !== undefined ||
    environment.REFLO_LOCAL_REDRIVE_RDS_PASSWORD !== undefined
  ) {
    await provisionRocketMqRoles(
      databaseUrl,
      requiredMatching(
        environment,
        "REFLO_LOCAL_RELAY_RDS_PASSWORD",
        /^[a-f0-9]{48}$/,
      ),
      requiredMatching(
        environment,
        "REFLO_LOCAL_REDRIVE_RDS_PASSWORD",
        /^[a-f0-9]{48}$/,
      ),
    );
  }
  await applySql(vectorDatabaseUrl, paths.vector);
  await applySql(vectorDatabaseUrl, paths.developmentVector);
  const vectorPassword = environment.REFLO_LOCAL_API_VECTOR_PASSWORD;
  if (vectorPassword !== undefined) {
    await provisionLocalVectorApiRole(vectorDatabaseUrl, vectorPassword);
  }

  const vector = new pg.Client(clientConfiguration(vectorDatabaseUrl));
  try {
    await vector.connect();
    const result = await vector.query(
      `SELECT extversion
       FROM pg_extension
       WHERE extname = 'vector'
         AND to_regclass('public.reflo_source_span_embedding_v1') IS NOT NULL
         AND to_regclass(
           'public.reflo_source_span_embedding_litellm_dev_v1'
         ) IS NOT NULL`,
    );
    if (result.rowCount !== 1) {
      throw new Error("local vector schemas did not reach the ready state");
    }
  } finally {
    await vector.end();
  }

  return Object.freeze({
    contractVersion: "local-application-database-setup-v1",
    outcome: "ready",
    runtimeDatabaseRole: "dml_only",
  });
}

export async function provisionRocketMqRoles(
  connectionString,
  relayPassword,
  redrivePassword,
) {
  if (
    !/^[a-f0-9]{48}$/.test(relayPassword) ||
    !/^[a-f0-9]{48}$/.test(redrivePassword) ||
    relayPassword === redrivePassword
  ) {
    throw new Error("RocketMQ database role passwords are invalid");
  }
  const client = new pg.Client(clientConfiguration(connectionString));
  try {
    await client.connect();
    const database = await client.query(
      "SELECT current_database() AS database_name",
    );
    const databaseName = database.rows[0]?.database_name;
    if (typeof databaseName !== "string" || databaseName === "") {
      throw new Error("RocketMQ application database name is unavailable");
    }
    for (const [role, password, functions] of [
      [
        LOCAL_RELAY_ROLE,
        relayPassword,
        [
          "reflo_claim_outbox_messages(text,timestamptz,integer,timestamptz)",
          "reflo_mark_outbox_published(uuid,text,timestamptz)",
          "reflo_release_outbox_message(uuid,text,text)",
        ],
      ],
      [
        LOCAL_REDRIVE_ROLE,
        redrivePassword,
        [
          "reflo_inspect_audio_redrive(uuid,timestamptz)",
          "reflo_claim_audio_redrive(uuid,uuid,text,text,timestamptz,timestamptz)",
          "reflo_mark_audio_redrive_published(uuid,uuid,text,timestamptz)",
          "reflo_release_audio_redrive(uuid,uuid,text,text,timestamptz)",
          "reflo_reject_audio_redrive(uuid,uuid,text,text,timestamptz)",
        ],
      ],
    ]) {
      const existing = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role],
      );
      await executeFormatted(
        client,
        existing.rowCount === 0
          ? "CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
          : "ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
        [role, password],
      );
      await executeFormatted(client, "GRANT CONNECT ON DATABASE %I TO %I", [
        databaseName,
        role,
      ]);
      await executeFormatted(client, "GRANT USAGE ON SCHEMA public TO %I", [
        role,
      ]);
      for (const functionSignature of functions) {
        await executeFormatted(client, "GRANT EXECUTE ON FUNCTION %s TO %I", [
          functionSignature,
          role,
        ]);
      }
    }
  } finally {
    await client.end();
  }
}

export async function provisionLocalVectorApiRole(connectionString, password) {
  if (!/^[a-f0-9]{48}$/.test(password)) {
    throw new Error("local vector API database password is invalid");
  }
  const client = new pg.Client(clientConfiguration(connectionString));
  try {
    await client.connect();
    const role = await client.query(
      `SELECT rolname
       FROM pg_roles
       WHERE rolname = $1`,
      [LOCAL_VECTOR_API_ROLE],
    );
    await executeFormatted(
      client,
      role.rowCount === 0
        ? "CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
        : "ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      [LOCAL_VECTOR_API_ROLE, password],
    );
    const database = await client.query(
      "SELECT current_database() AS database_name",
    );
    const databaseName = database.rows[0]?.database_name;
    if (typeof databaseName !== "string" || databaseName === "") {
      throw new Error("local vector application database name is unavailable");
    }
    await executeFormatted(client, "GRANT CONNECT ON DATABASE %I TO %I", [
      databaseName,
      LOCAL_VECTOR_API_ROLE,
    ]);
    await executeFormatted(client, "GRANT USAGE ON SCHEMA public TO %I", [
      LOCAL_VECTOR_API_ROLE,
    ]);
    for (const table of [
      "reflo_source_span_embedding_v1",
      "reflo_source_span_embedding_litellm_dev_v1",
    ]) {
      await executeFormatted(client, "GRANT SELECT, INSERT ON TABLE %I TO %I", [
        table,
        LOCAL_VECTOR_API_ROLE,
      ]);
    }
  } finally {
    await client.end();
  }
}

export async function provisionLocalApiRole(connectionString, password) {
  if (!/^[a-f0-9]{48}$/.test(password)) {
    throw new Error("local API database password is invalid");
  }
  const client = new pg.Client(clientConfiguration(connectionString));
  try {
    await client.connect();
    const role = await client.query(
      `SELECT rolname
       FROM pg_roles
       WHERE rolname = $1`,
      [LOCAL_API_ROLE],
    );
    await executeFormatted(
      client,
      role.rowCount === 0
        ? "CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
        : "ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      [LOCAL_API_ROLE, password],
    );

    const database = await client.query(
      "SELECT current_database() AS database_name",
    );
    const databaseName = database.rows[0]?.database_name;
    if (typeof databaseName !== "string" || databaseName === "") {
      throw new Error("local application database name is unavailable");
    }
    await executeFormatted(
      client,
      "REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC",
      [databaseName],
    );
    await executeFormatted(
      client,
      "REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I",
      [databaseName, LOCAL_API_ROLE],
    );
    await executeFormatted(client, "GRANT CONNECT ON DATABASE %I TO %I", [
      databaseName,
      LOCAL_API_ROLE,
    ]);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await executeFormatted(client, "REVOKE CREATE ON SCHEMA public FROM %I", [
      LOCAL_API_ROLE,
    ]);
    await executeFormatted(client, "GRANT USAGE ON SCHEMA public TO %I", [
      LOCAL_API_ROLE,
    ]);
    await executeFormatted(
      client,
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I",
      [LOCAL_API_ROLE],
    );
    await executeFormatted(
      client,
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I",
      [LOCAL_API_ROLE],
    );
    await executeFormatted(
      client,
      "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I",
      [LOCAL_API_ROLE],
    );
    await executeFormatted(
      client,
      "REVOKE ALL ON TABLE rocketmq_redrive_request, rocketmq_redrive_audit FROM %I",
      [LOCAL_API_ROLE],
    );
    await executeFormatted(
      client,
      "REVOKE ALL ON SEQUENCE rocketmq_redrive_audit_id_seq FROM %I",
      [LOCAL_API_ROLE],
    );
    for (const functionSignature of [
      "reflo_claim_outbox_messages(text,timestamptz,integer,timestamptz)",
      "reflo_mark_outbox_published(uuid,text,timestamptz)",
      "reflo_release_outbox_message(uuid,text,text)",
      "reflo_inspect_audio_redrive(uuid,timestamptz)",
      "reflo_claim_audio_redrive(uuid,uuid,text,text,timestamptz,timestamptz)",
      "reflo_mark_audio_redrive_published(uuid,uuid,text,timestamptz)",
      "reflo_release_audio_redrive(uuid,uuid,text,text,timestamptz)",
      "reflo_reject_audio_redrive(uuid,uuid,text,text,timestamptz)",
    ]) {
      await executeFormatted(client, "REVOKE EXECUTE ON FUNCTION %s FROM %I", [
        functionSignature,
        LOCAL_API_ROLE,
      ]);
    }

    const privileges = await client.query(
      `SELECT
         role.rolsuper,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolinherit,
         role.rolreplication,
         role.rolbypassrls,
         has_database_privilege(role.rolname, current_database(), 'CREATE')
           AS can_create_database_objects,
         has_database_privilege(role.rolname, current_database(), 'TEMPORARY')
           AS can_create_temporary_tables,
         has_schema_privilege(role.rolname, 'public', 'CREATE')
           AS can_create_schema_objects
       FROM pg_roles AS role
       WHERE role.rolname = $1`,
      [LOCAL_API_ROLE],
    );
    const state = privileges.rows[0];
    if (
      privileges.rowCount !== 1 ||
      state.rolsuper ||
      state.rolcreatedb ||
      state.rolcreaterole ||
      state.rolinherit ||
      state.rolreplication ||
      state.rolbypassrls ||
      state.can_create_database_objects ||
      state.can_create_temporary_tables ||
      state.can_create_schema_objects
    ) {
      throw new Error("local API database role retains DDL capability");
    }
  } finally {
    await client.end();
  }
}

async function applySql(connectionString, file) {
  const client = new pg.Client(clientConfiguration(connectionString));
  try {
    const sql = await readFile(file, "utf8");
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function executeFormatted(client, template, values) {
  const placeholders = values
    .map((_, index) => `$${index + 2}::text`)
    .join(", ");
  const result = await client.query(
    `SELECT format($1, ${placeholders}) AS sql`,
    [template, ...values],
  );
  const sql = result.rows[0]?.sql;
  if (typeof sql !== "string" || sql === "") {
    throw new Error("failed to build local role statement");
  }
  await client.query(sql);
}

function clientConfiguration(connectionString) {
  return {
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  };
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredMatching(environment, name, pattern) {
  const value = required(environment, name);
  if (!pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const result = await prepareLocalApplicationProfile();
  console.info(JSON.stringify(result));
}
