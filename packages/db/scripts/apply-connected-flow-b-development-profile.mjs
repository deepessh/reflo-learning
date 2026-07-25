#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const databaseUrl = required("DATABASE_URL");
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sql = await readFile(
  path.join(packageRoot, "sql/local-smoke-development-profile.sql"),
  "utf8",
);
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.info(
    JSON.stringify({
      contractVersion: "connected-flow-b-development-profile-v1",
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
