#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { migrateStrict } from "./strict-migrate.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
  const paths = resolveLocalSchemaPaths();

  await migrateStrict(databaseUrl);
  await applySql(databaseUrl, paths.developmentRds);
  await applySql(vectorDatabaseUrl, paths.vector);
  await applySql(vectorDatabaseUrl, paths.developmentVector);

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
  });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareLocalApplicationProfile();
  console.info(JSON.stringify(result));
}
