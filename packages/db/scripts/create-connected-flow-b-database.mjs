#!/usr/bin/env node

import pg from "pg";

const DATABASE_NAME = "reflo_flow_b_164";
const baseUrl = required("REFLO_FLOW_B_BASE_DATABASE_URL");
const client = new pg.Client({ connectionString: baseUrl });

try {
  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [DATABASE_NAME],
  );
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE ${DATABASE_NAME}`);
  }
  console.info(
    JSON.stringify({
      contractVersion: "connected-flow-b-database-v1",
      created: existing.rowCount === 0,
      outcome: "ready",
    }),
  );
} finally {
  await client.end();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
