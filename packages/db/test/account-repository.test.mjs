import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresAccountRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

test(
  "PostgresAccountRepository reserves free email capacity atomically",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_account_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let repository;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      await execFileAsync(
        process.execPath,
        [path.join(packageRoot, "scripts/strict-migrate.mjs")],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        },
      );
      repository = new PostgresAccountRepository(databaseUrl.toString());

      const firstDay = new Date("2026-07-20T23:59:00.000Z");
      const firstResults = await Promise.all(
        Array.from({ length: 6 }, () =>
          repository.reserveMagicLinkDelivery(firstDay, 2, 3),
        ),
      );
      assert.equal(firstResults.filter(Boolean).length, 2);

      const secondDay = new Date("2026-07-22T00:01:00.000Z");
      const secondResults = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.reserveMagicLinkDelivery(secondDay, 2, 3),
        ),
      );
      assert.equal(secondResults.filter(Boolean).length, 1);
    } finally {
      await repository?.close();
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  },
);
