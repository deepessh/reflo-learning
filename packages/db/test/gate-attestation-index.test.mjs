import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresGateAttestationIndex } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

test(
  "PostgresGateAttestationIndex keeps immutable history and one current verdict",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_gate_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let index;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      await execFileAsync(
        process.execPath,
        [path.join(packageRoot, "scripts/strict-migrate.mjs")],
        { env: { ...process.env, DATABASE_URL: databaseUrl.toString() } },
      );
      index = new PostgresGateAttestationIndex(databaseUrl.toString());
      const first = attestation("a", "2026-07-21T16:00:00.000Z", "passed");
      await index.publish(first);
      await index.publish(first);
      assert.deepEqual(
        await index.readCurrent("staging", "week1.performance"),
        first,
      );

      const second = attestation("b", "2026-07-21T17:00:00.000Z", "failed");
      await index.publish(second);
      assert.deepEqual(
        await index.readCurrent("staging", "week1.performance"),
        second,
      );
      await assert.rejects(
        index.publish(attestation("c", "2026-07-21T15:00:00.000Z", "passed")),
        /gate_attestation_not_newer/,
      );

      const database = new pg.Client({
        connectionString: databaseUrl.toString(),
      });
      await database.connect();
      const rows = await database.query(
        `SELECT evidence_bundle_digest, superseded_at IS NULL AS current
         FROM release_gate_attestation
         ORDER BY published_at`,
      );
      await database.end();
      assert.deepEqual(rows.rows, [
        {
          current: false,
          evidence_bundle_digest: `sha256:${"a".repeat(64)}`,
        },
        {
          current: true,
          evidence_bundle_digest: `sha256:${"b".repeat(64)}`,
        },
      ]);
    } finally {
      await index?.close();
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

function attestation(digestCharacter, publishedAt, status) {
  return {
    attestationVersion: "gate-attestation-v1",
    contractVersion: "evaluation-contract-v1",
    dependencyFingerprints: { schema: "d".repeat(64) },
    deployableArtifactDigest: `sha256:${"e".repeat(64)}`,
    environment: "staging",
    evidenceBundleDigest: `sha256:${digestCharacter.repeat(64)}`,
    evidenceBundleReference: `oss-evidence:sha256/${digestCharacter.repeat(64)}`,
    gateId: "week1.performance",
    mutableEvidence: [
      {
        kind: "capacity",
        reference: "issue:35-capacity",
        status: "valid",
        validUntil: "2026-08-07T00:00:00.000Z",
      },
    ],
    publishedAt,
    publisherAuthorizationReference: "issue:35-publisher",
    publisherId: "release-publisher-01",
    status,
  };
}
