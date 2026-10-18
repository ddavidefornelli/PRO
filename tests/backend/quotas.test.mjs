import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

let db;
let week;
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);
const analysis = { summary: "A week", mainReasons: [], improvements: ["Keep logging"] };
before(async () => {
  db = new PGlite();
  // Minimal Supabase platform fixtures; the migration itself is run unchanged.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    insert into auth.users values ('${user}'), ('${other}');
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261017000100_weekly_reviews.sql", import.meta.url), "utf8"));
  week = (await db.query("select (date_trunc('week', now() at time zone 'UTC')::date - 7)::text as week")).rows[0].week;
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate public.ai_review_requests, public.ai_usage; update public.ai_controls set enabled = true, daily_attempt_limit = 150, monthly_attempt_limit = 600;");
});
async function reserve(id = user, fingerprint = hash) {
  return (await db.query("select public.reserve_weekly_review($1, $2, $3, 'weekly-ai-v1') as result", [id, week, fingerprint])).rows[0].result;
}
async function finish(claim, token = claim.leaseToken) {
  return (await db.query("select public.finish_weekly_review($1, $2, $3::jsonb, 'gpt-4.1-mini') as result", [claim.id, token, JSON.stringify(analysis)])).rows[0].result;
}
async function usage() {
  return (await db.query("select attempts from public.ai_usage order by period")).rows.map(({ attempts }) => attempts);
}

test("Postgres: concurrent reservations consume one attempt and return running to the duplicate", async () => {
  const claims = await Promise.all([reserve(), reserve()]);
  assert.deepEqual(claims.map(({ outcome }) => outcome).sort(), ["reserved", "running"]);
  assert.deepEqual(await usage(), [1, 1]);
});

test("Postgres: successful reviews are immutable and cached without consuming allowance", async () => {
  const claim = await reserve();
  assert.equal(await finish(claim), true);
  assert.equal(await finish(claim), false);
  const cached = await reserve();
  assert.equal(cached.outcome, "cached");
  assert.deepEqual(cached.analysis, analysis);
  assert.equal((await reserve(user, "b".repeat(64))).outcome, "conflict");
  assert.deepEqual(await usage(), [1, 1]);
});

test("Postgres: failures have hourly backoff, capped attempts, and no budget refund", async () => {
  let claim = await reserve();
  await db.query("select public.fail_weekly_review($1, $2)", [claim.id, claim.leaseToken]);
  assert.equal((await reserve()).outcome, "rate_limited");
  for (let i = 0; i < 2; i++) {
    await db.exec("update public.ai_review_requests set last_attempt_at = now() - interval '2 hours', lease_until = now() - interval '1 hour'");
    claim = await reserve();
    assert.equal(claim.outcome, "reserved");
    await db.query("select public.fail_weekly_review($1, $2)", [claim.id, claim.leaseToken]);
  }
  await db.exec("update public.ai_review_requests set last_attempt_at = now() - interval '2 hours'");
  assert.equal((await reserve()).outcome, "rate_limited");
  assert.deepEqual(await usage(), [3, 3]);
});

test("Postgres: lease expiry recovers interrupted requests but rejects stale completion tokens", async () => {
  const stale = await reserve();
  await db.exec("update public.ai_review_requests set last_attempt_at = now() - interval '2 hours', lease_until = now() - interval '1 hour'");
  const fresh = await reserve();
  assert.equal(fresh.outcome, "reserved");
  assert.notEqual(stale.leaseToken, fresh.leaseToken);
  assert.equal(await finish(stale), false);
  assert.equal(await finish(fresh), true);
});

test("Postgres: global daily/monthly caps and kill switch fail closed across identities", async () => {
  await db.exec("update public.ai_controls set daily_attempt_limit = 1");
  assert.equal((await reserve()).outcome, "reserved");
  assert.equal((await reserve(other)).outcome, "global_limit");
  await db.exec("update public.ai_controls set daily_attempt_limit = 150, monthly_attempt_limit = 1");
  assert.equal((await reserve(other)).outcome, "global_limit");
  await db.exec("update public.ai_controls set enabled = false");
  assert.equal((await reserve()).outcome, "disabled");
  assert.deepEqual(await usage(), [1, 1]);
});

test("Postgres: changing local weeks cannot bypass the server's UTC weekly allowance", async () => {
  assert.equal((await reserve()).outcome, "reserved");
  const nextWeek = (await db.query("select ($1::date + 7)::text as week", [week])).rows[0].week;
  const result = (await db.query("select public.reserve_weekly_review($1, $2, $3, 'weekly-ai-v1') as result", [user, nextWeek, hash])).rows[0].result;
  assert.ok(["invalid", "weekly_limit"].includes(result.outcome));
  assert.deepEqual(await usage(), [1, 1]);
});

test("Postgres: clients cannot read operational tables or execute service-only functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(() => db.query("select * from public.ai_review_requests"), /permission denied/);
      await assert.rejects(() => db.query("select * from public.ai_controls"), /permission denied/);
      await assert.rejects(() => reserve(), /permission denied/);
      await assert.rejects(() => db.query("select public.purge_weekly_review_content()"), /permission denied/);
    } finally { await db.exec("reset role"); }
  }
  await db.exec("set role service_role");
  try { assert.equal((await reserve()).outcome, "reserved"); }
  finally { await db.exec("reset role"); }
});

test("Postgres: cached content expires after seven days; cleanup preserves recent quota tombstones", async () => {
  const claim = await reserve();
  await finish(claim);
  await db.exec("update public.ai_review_requests set generated_at = now() - interval '8 days'");
  assert.equal((await reserve()).outcome, "expired");
  await db.exec("select public.purge_weekly_review_content()");
  const row = (await db.query("select status, analysis from public.ai_review_requests")).rows[0];
  assert.equal(row.analysis, null);
  assert.equal(row.status, "succeeded");
  assert.equal((await reserve()).outcome, "expired");
  assert.deepEqual(await usage(), [1, 1]);
});

test("Postgres: invalid consent, hash, and historical weeks cannot consume quota", async () => {
  for (const args of [
    [user, week, hash, "old-consent"],
    [user, week, "bad-hash", "weekly-ai-v1"],
    [user, "2020-01-06", hash, "weekly-ai-v1"],
  ]) {
    const result = (await db.query("select public.reserve_weekly_review($1, $2, $3, $4) as result", args)).rows[0].result;
    assert.equal(result.outcome, "invalid");
  }
  assert.deepEqual(await usage(), []);
});
