import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHandler } from "../../supabase/functions/weekly-review/handler.ts";
import { platformDependencies } from "../../supabase/functions/weekly-review/platform.ts";
import { ALICE, BOB, database } from "../helpers/database.mjs";

let f;
before(async () => { f = await database(); });
after(async () => { await f?.db.close(); });
beforeEach(async () => { await f.reset(); });

async function fixture(provider) {
  await f.call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
  await f.db.query("insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes) values ($1, 'Weekly context', $2, 1, 30)", [ALICE, f.dates.week]);
  const calls = [];
  const rpc = {
    planner_preview_input: (a) => ["select public.planner_preview_input($1, $2) result", [a.p_user_id, a.p_timezone]],
    reserve_review_preview: (a) => ["select public.reserve_review_preview($1) result", [a.p_user_id]],
    finish_review_preview: (a) => ["select public.finish_review_preview($1, $2) result", [a.p_id, a.p_lease_token]],
    fail_review_preview: (a) => ["select public.fail_review_preview($1, $2) result", [a.p_id, a.p_lease_token]],
    planner_review_input: (a) => ["select public.planner_review_input($1, $2) result", [a.p_user_id, a.p_timezone]],
    reserve_planner_review: (a) => ["select public.reserve_planner_review($1, $2, $3, $4, $5::jsonb) result", [a.p_user_id, a.p_week_start, a.p_request_hash, a.p_consent_version, JSON.stringify(a.p_activity)]],
    finish_weekly_review: (a) => ["select public.finish_weekly_review($1, $2, $3::jsonb, $4) result", [a.p_id, a.p_lease_token, JSON.stringify(a.p_analysis), a.p_model]],
    fail_weekly_review: (a) => ["select public.fail_weekly_review($1, $2) result", [a.p_id, a.p_lease_token]],
  };
  const fetcher = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "error"); assert.ok(init.signal);
    if (url === "https://fixture.invalid/auth/v1/user") {
      assert.equal(init.headers.Authorization, "Bearer signed-in-fixture");
      assert.equal(init.headers.apikey, "public-fixture");
      return Response.json({ id: ALICE, email: "alice@example.com", role: "authenticated", is_anonymous: false });
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      assert.equal(init.headers.Authorization, "Bearer provider-fixture-secret");
      return provider(JSON.parse(init.body));
    }
    assert.equal(init.headers.apikey, "service-fixture-secret");
    assert.equal(init.headers.Authorization, "Bearer service-fixture-secret");
    const name = url.split("/").at(-1); assert.ok(Object.hasOwn(rpc, name), `Unexpected endpoint ${url}`);
    const [sql, args] = rpc[name](JSON.parse(init.body));
    const result = await f.as(null, async (tx) => (await tx.query(sql, args)).rows[0].result, "service_role");
    return Response.json(result);
  };
  const handler = createHandler(platformDependencies({ url: "https://fixture.invalid", publicKey: "public-fixture", serviceKey: "service-fixture-secret", openAiKey: "provider-fixture-secret" }, fetcher));
  const request = (preview = false) => new Request("https://fixture.invalid/functions/v1/weekly-review", { method: "POST", headers: { Authorization: "Bearer signed-in-fixture", "Content-Type": "application/json" }, body: JSON.stringify({ timezone: "UTC", preview }) });
  return { run: (preview = false) => handler(request(preview)), calls };
}
const output = { summary: "One planned outcome. No stops were recorded.", mainReasons: [], improvements: ["Record necessary breaks when they happen."] };
const providerSuccess = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });

test("full Edge pipeline: authenticated input → actual SQL reservation → provider fixture → durable SQL review → cache", async () => {
  const h = await fixture((body) => {
    assert.equal(body.model, "gpt-4.1-mini"); assert.equal(body.store, false);
    const source = JSON.parse(body.messages[1].content);
    assert.equal(source.activity.tasks[0].outcome, "Weekly context");
    assert.ok(!JSON.stringify(source).includes("resources")); return providerSuccess();
  });
  const first = await h.run(); assert.equal(first.status, 200); assert.equal((await first.json()).cached, false);
  const cached = await h.run(); assert.equal(cached.status, 200); assert.equal((await cached.json()).cached, true);
  assert.equal(h.calls.filter((url) => url.startsWith("https://api.openai.com/")).length, 1);
  assert.deepEqual((await f.call("weekly_overview")).reviews[0].analysis, output);
  assert.deepEqual((await f.call("weekly_overview", {}, BOB)).reviews, []);
  assert.equal((await f.db.query("select activity from public.ai_review_requests")).rows[0].activity, null);
  assert.deepEqual((await f.db.query("select attempts from public.ai_usage order by period")).rows.map((r) => r.attempts), [1, 1]);
});

test("full Edge preview pipeline uses separate leases, returns a transient report, and preserves weekly allowance", async () => {
  const h = await fixture(providerSuccess);
  await f.create("Current task");
  const response = await h.run(true);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.review.weekEnd, f.dates.today);
  assert.ok(body.review.activity.tasks.some((task) => task.outcome === "Current task"));
  assert.deepEqual(body.review.analysis, output);
  assert.deepEqual((await f.call("weekly_overview")).reviews, []);
  assert.equal((await f.db.query("select count(*)::int n from public.ai_review_requests")).rows[0].n, 0);
  assert.equal((await h.run(true)).status, 429);
  assert.equal((await h.run()).status, 200);
});

test("full Edge pipeline: malformed provider result invokes service-only failure cleanup without a durable review", async () => {
  const h = await fixture(() => new Response("private upstream API key", { status: 500 }));
  const response = await h.run(); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("private"));
  assert.ok(h.calls.some((url) => url.endsWith("/fail_weekly_review")));
  assert.deepEqual((await f.db.query("select status, activity from public.ai_review_requests")).rows, [{ status: "failed", activity: null }]);
  assert.deepEqual((await f.call("weekly_overview")).reviews, []);
});

test("full Edge pipeline: consent revoked during provider generation refuses persistence and clears operational input", async () => {
  const h = await fixture(async () => { await f.call("set_weekly_ai_enabled", { enabled: false }); return providerSuccess(); });
  const response = await h.run(); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "save_failed");
  assert.deepEqual((await f.call("weekly_overview")).reviews, []);
  assert.equal((await f.db.query("select activity from public.ai_review_requests")).rows[0].activity, null);
});
