import assert from "node:assert/strict";
import test from "node:test";

import { access } from "node:fs/promises";

import {
  findOutOfOrderMigrations,
  resolveDbmateCli,
} from "../scripts/strict-migrate.mjs";

test("accepts pending migrations newer than every applied version", () => {
  assert.deepEqual(
    findOutOfOrderMigrations(
      ["20260719000100", "20260720000100"],
      ["20260719000100"],
    ),
    [],
  );
});

test("rejects a pending migration older than an applied version", () => {
  assert.deepEqual(
    findOutOfOrderMigrations(
      ["20260719000100", "20260720000100", "20260721000100"],
      ["20260719000100", "20260721000100"],
    ),
    ["20260720000100"],
  );
});

test("rejects applied versions absent from the checkout", () => {
  assert.throws(
    () => findOutOfOrderMigrations(["20260719000100"], ["20260718000100"]),
    /absent from this checkout/,
  );
});

test("resolves the packaged dbmate CLI without relying on a generated bin shim", async () => {
  const cli = resolveDbmateCli();
  assert.match(cli, /dbmate[/\\]dist[/\\]cli[.]js$/);
  await access(cli);
});
