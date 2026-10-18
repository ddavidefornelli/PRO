import assert from "node:assert/strict";
import test from "node:test";
import { database, ALICE, BOB } from "../helpers/database.mjs";
import { createHandler } from "../../supabase/functions/weekly-review/handler.ts";
import { validateInput } from "../../supabase/functions/weekly-review/domain.ts";

const now = new Date("2026-10-21T12:00:00Z");
const input = { consentVersion: "weekly-ai-v1", weekStart: "2026-10-19", weekEnd: "2026-10-21",
  activity: { tasks: [{ id: "a", outcome: "A task", plannedFor: "2026-10-20", completedOn: "2026-10-21", status: "completed", estimatedMinutes: 30, actualSeconds: 2400 }],
    stops: [], totalStops: 0, omittedStops: 0 } };
const analysis = { summary: "A partial week.", mainReasons: [], improvements: ["Try a longer estimate."] };
const request = (body) => new Request("https://example.invalid", { method: "POST", headers: { Authorization: "Bearer session", "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("preview validates only current local week so far, leaving closed-week rules unchanged", () => {
  assert.deepEqual(validateInput(input, now, true), input);
  assert.throws(() => validateInput(input, now));
  assert.throws(() => validateInput({ ...input, weekEnd: "2026-10-25" }, now, true));
  assert.throws(() => validateInput({ ...input, weekStart: "2026-10-12" }, now, true));
});

test("preview HTTP path passes mode through all stages and returns source evidence without weekly persistence", async () => {
  const calls = [];
  const handler = createHandler({
    authenticate: async () => ALICE,
    loadInput: async (id, timezone, preview) => { assert.equal(id, ALICE); assert.equal(timezone, "UTC"); assert.equal(preview, true); return input; },
    reserve: async (id, source, hash, preview) => { assert.equal(preview, true); calls.push("reserve"); return { outcome: "reserved", id: ALICE, leaseToken: "token" }; },
    generate: async () => analysis,
    finish: async (id, token, output, preview) => { assert.equal(preview, true); calls.push("finish"); return true; },
    fail: async () => { throw new Error("Unexpected failure"); }, now: () => now, allowedOrigins: new Set(),
  });
  const response = await handler(request({ timezone: "UTC", preview: true }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.review.activity, input.activity);
  assert.deepEqual(result.review.analysis, analysis);
  assert.equal(result.review.weekEnd, input.weekEnd);
  assert.deepEqual(calls, ["reserve", "finish"]);
  assert.equal((await handler(request({ timezone: "UTC", preview: "yes" }))).status, 400);
  assert.equal((await handler(request({ timezone: "UTC", preview: true, model: "other" }))).status, 400);
});

test("preview SQL enforces consent, separate daily quota, cooldown, leases, budget and service-only access", async () => {
  const { db, call, create, dates, as } = await database();
  const rpc = async (name, args = [ALICE]) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`, args)).rows[0].result;
  try {
    await db.exec("update public.ai_controls set enabled = true");
    assert.equal((await rpc("reserve_review_preview")).outcome, "disabled");
    await call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
    await create();
    const source = await rpc("planner_preview_input", [ALICE, "UTC"]);
    assert.equal(source.weekEnd, dates.today);
    assert.equal(source.activity.tasks.length, 1);
    validateInput(source, new Date(), true);
    const first = await rpc("reserve_review_preview");
    assert.equal(first.outcome, "reserved");
    assert.equal((await rpc("reserve_review_preview")).outcome, "running");
    assert.equal(await rpc("finish_review_preview", [ALICE, BOB]), false);
    assert.equal(await rpc("finish_review_preview", [ALICE, first.leaseToken]), true);
    assert.equal((await rpc("reserve_review_preview")).outcome, "rate_limited");
    assert.equal((await db.query("select count(*)::int n from public.ai_review_requests")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from public.planner_reviews")).rows[0].n, 0);
    await db.exec("update public.ai_review_previews set last_attempt_at = now() - interval '11 minutes'");
    const second = await rpc("reserve_review_preview");
    assert.equal(second.outcome, "reserved");
    // A consent revision change invalidates in-flight completion.
    await call("set_weekly_ai_enabled", { enabled: false });
    await call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
    assert.equal(await rpc("finish_review_preview", [ALICE, second.leaseToken]), false);
    assert.equal(await rpc("fail_review_preview", [ALICE, second.leaseToken]), true);
    await db.exec("update public.ai_review_previews set last_attempt_at = now() - interval '11 minutes'");
    const third = await rpc("reserve_review_preview");
    assert.equal(third.outcome, "reserved");
    await rpc("fail_review_preview", [ALICE, third.leaseToken]);
    await db.exec("update public.ai_review_previews set last_attempt_at = now() - interval '11 minutes'");
    assert.equal((await rpc("reserve_review_preview")).outcome, "rate_limited");
    assert.equal((await db.query("select attempts from public.ai_usage where period like 'day:%'")).rows[0].attempts, 3);
    await db.exec("update public.ai_review_previews set quota_day = quota_day - 1");
    await db.exec("update public.ai_controls set daily_attempt_limit = 3");
    assert.equal((await rpc("reserve_review_preview")).outcome, "global_limit");
    await db.exec("update public.ai_controls set enabled = false");
    assert.equal((await rpc("reserve_review_preview")).outcome, "disabled");
    await assert.rejects(() => as(ALICE, (tx) => tx.query("select * from public.ai_review_previews")));
    await assert.rejects(() => as(ALICE, (tx) => tx.query("select public.reserve_review_preview($1)", [BOB])));
  } finally { await db.close(); }
});
