import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ALICE, BOB, database, uuid } from "../helpers/database.mjs";
import { analysis } from "../helpers/review.mjs";

let f;
before(async () => { f = await database(); });
after(async () => { await f?.db.close(); });
beforeEach(async () => { await f.reset(); });
async function reserve() {
  await f.call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
  await f.db.query("insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes) values ($1, 'Weekly work', $2, 1, 30)", [ALICE, f.dates.week]);
  const input = (await f.db.query("select public.planner_review_input($1, 'UTC') result", [ALICE])).rows[0].result;
  const claim = (await f.db.query("select public.reserve_planner_review($1, $2, $3, 'weekly-ai-v1', $4::jsonb) result", [ALICE, f.dates.week, "a".repeat(64), JSON.stringify(input.activity)])).rows[0].result;
  assert.equal(claim.outcome, "reserved");
  return claim;
}
async function finish(claim, token = claim.leaseToken, report = analysis(), model = "gpt-4.1-mini") {
  return (await f.db.query("select public.finish_weekly_review($1, $2, $3::jsonb, $4) result", [claim.id, token, JSON.stringify(report), model])).rows[0].result;
}
for (const [name, change] of [
  ["null lease", { token: null }], ["wrong lease", { token: uuid(100) }],
  ["null analysis", { report: null }], ["array analysis", { report: [] }],
  ["oversized analysis", { report: { summary: "x".repeat(65537) } }],
  ["null model", { model: null }], ["empty model", { model: "" }], ["oversized model", { model: "x".repeat(121) }],
]) {
  test(`SQL durable AI finish rejects ${name} without changing lease or creating a review`, async () => {
    const claim = await reserve();
    const before = (await f.db.query("select * from public.ai_review_requests")).rows;
    const args = { token: claim.leaseToken, report: analysis(), model: "gpt-4.1-mini", ...change };
    assert.equal(await finish(claim, args.token, args.report, args.model), false);
    assert.deepEqual((await f.db.query("select * from public.ai_review_requests")).rows, before);
    assert.deepEqual((await f.db.query("select * from public.planner_reviews")).rows, []);
    assert.equal(await finish(claim), true, "a rejected completion must not poison the legitimate lease");
  });
}

test("SQL missing consent revision fails closed even with a valid lease token", async () => {
  const claim = await reserve();
  await f.db.exec("update public.ai_review_requests set consent_revision = null");
  assert.equal(await finish(claim), false);
  assert.deepEqual((await f.db.query("select * from public.planner_reviews")).rows, []);
});

test("SQL expired leases cannot persist reviews even with a matching token", async () => {
  const claim = await reserve();
  await f.db.exec("update public.ai_review_requests set lease_until = now() - interval '1 second'");
  assert.equal(await finish(claim), false);
  assert.equal((await f.call("weekly_overview")).status, "failed");
});

test("SQL failure cleans source activity and a stale failure cannot erase a newer lease", async () => {
  const stale = await reserve();
  await f.db.exec("update public.ai_review_requests set lease_until = now() - interval '1 hour', last_attempt_at = now() - interval '2 hours'");
  const row = (await f.db.query("select activity from public.ai_review_requests")).rows[0];
  const fresh = (await f.db.query("select public.reserve_planner_review($1, $2, $3, 'weekly-ai-v1', $4::jsonb) result", [ALICE, f.dates.week, "a".repeat(64), JSON.stringify(row.activity)])).rows[0].result;
  assert.equal(fresh.outcome, "reserved");
  assert.equal((await f.db.query("select public.fail_weekly_review($1, $2) result", [stale.id, stale.leaseToken])).rows[0].result, false);
  assert.notEqual((await f.db.query("select activity from public.ai_review_requests")).rows[0].activity, null);
  assert.equal((await f.db.query("select public.fail_weekly_review($1, $2) result", [fresh.id, fresh.leaseToken])).rows[0].result, true);
  assert.equal((await f.db.query("select activity from public.ai_review_requests")).rows[0].activity, null);
});

test("SQL retention erases expired operational inputs, not active leases, receipts or durable reviews", async () => {
  const claim = await reserve(); await finish(claim);
  await f.call("create_task", { outcome: "Retain my receipt", day: f.dates.today, estimatedMinutes: 10, _requestId: uuid(1), _at: Number(f.dates.epoch) });
  await f.db.query("insert into public.ai_review_requests(user_id, quota_week, week_start, request_hash, consent_version, status, lease_token, lease_until, activity) values ($1, $2, $2, $3, 'weekly-ai-v1', 'running', $4, now() + interval '1 minute', '{\"private\":true}')", [BOB, f.dates.week, "b".repeat(64), uuid(7)]);
  await f.db.exec("update public.ai_review_requests set generated_at = now() - interval '8 days' where status = 'succeeded'; select public.purge_weekly_review_content()");
  assert.equal((await f.db.query("select analysis from public.ai_review_requests where status = 'succeeded'")).rows[0].analysis, null);
  assert.deepEqual((await f.db.query("select activity from public.ai_review_requests where status = 'running'")).rows[0].activity, { private: true });
  assert.equal((await f.db.query("select count(*)::int n from public.planner_reviews")).rows[0].n, 1);
  assert.equal((await f.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, 1);
  await f.db.exec("update public.ai_review_requests set lease_until = now() - interval '1 minute' where status = 'running'; select public.purge_weekly_review_content()");
  assert.equal((await f.db.query("select activity from public.ai_review_requests where status = 'running'")).rows[0].activity, null);
});

test("SQL review history returns only the latest 52, newest first, and remains private", async () => {
  await f.db.query("insert into public.planner_reviews(user_id, week_start, report) select $1, $2::date - (s * 7), jsonb_build_object('week', s) from generate_series(0, 59) s", [ALICE, f.dates.week]);
  const overview = await f.call("weekly_overview");
  assert.equal(overview.reviews.length, 52);
  assert.deepEqual(overview.reviews.map((r) => r.week), Array.from({ length: 52 }, (_, i) => i));
  assert.deepEqual((await f.call("weekly_overview", {}, BOB)).reviews, []);
});

test("SQL every internal security-definer function has an empty search path and no PUBLIC execute", async () => {
  const functions = (await f.db.query(`select proname, proconfig, has_function_privilege('anon', p.oid, 'execute') anon,
    has_function_privilege('authenticated', p.oid, 'execute') authenticated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).rows;
  assert.ok(functions.length >= 10);
  for (const fn of functions) {
    assert.ok(fn.proconfig?.includes('search_path=""'), fn.proname);
    assert.equal(fn.anon, false, fn.proname);
    assert.equal(fn.authenticated, fn.proname === "planner_call", fn.proname);
  }
});
