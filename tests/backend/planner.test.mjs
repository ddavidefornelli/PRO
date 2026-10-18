import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
let db, today, tomorrow, week;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${alice}'), ('${bob}');
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
    $$;
    grant usage on schema auth to authenticated, anon;
  `);
  for (const file of ["20261017000100_weekly_reviews.sql", "20261017000200_cloud_planner.sql", "20261017000300_local_queue.sql", "20261017000400_review_lease_validation.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
  }
  ({ today, tomorrow, week } = (await db.query("select (now() at time zone 'UTC')::date::text today, ((now() at time zone 'UTC')::date + 1)::text tomorrow, (date_trunc('week', now() at time zone 'UTC')::date - 7)::text week")).rows[0]);
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("reset role; truncate public.planner_receipts, public.planner_accounts, public.planner_tasks, public.planner_resources, public.planner_stops, public.planner_reviews, public.ai_review_requests, public.ai_usage restart identity cascade; update public.ai_controls set enabled = true, daily_attempt_limit = 150, monthly_attempt_limit = 600;");
});
async function asUser(user, work, anonymous = false) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: user, role: "authenticated", is_anonymous: anonymous })]);
  await db.exec("set role authenticated");
  try { return await work(); }
  finally { await db.exec("reset role"); }
}
async function call(action, args = {}, user = alice, timezone = "UTC") {
  return asUser(user, async () => (await db.query("select public.planner_call($1, $2::jsonb, $3) result", [action, JSON.stringify(args), timezone])).rows[0].result);
}
async function queued(action, args, requestId, at = Math.floor(Date.now() / 1000), user = alice) {
  return call(action, { ...args, _requestId: requestId, _at: at }, user);
}
async function create(outcome = "A task", user = alice) {
  return call("create_task", { outcome, day: today, estimatedMinutes: 30 }, user);
}
async function seedWeek(user = alice) {
  await call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" }, user);
  return (await db.query("insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, is_priority) values ($1, 'Last week', $2, 1, 30, true) returning id", [user, week])).rows[0].id;
}
async function prepareReview() {
  await seedWeek();
  const input = (await db.query("select public.planner_review_input($1, 'UTC') result", [alice])).rows[0].result;
  const claim = (await db.query("select public.reserve_planner_review($1, $2, $3, $4, $5::jsonb) result", [alice, week, "a".repeat(64), "weekly-ai-v1", JSON.stringify(input.activity)])).rows[0].result;
  return { input, claim };
}
const analysis = { summary: "A week", mainReasons: [], improvements: ["Keep logging"] };
async function finish(claim) {
  return (await db.query("select public.finish_weekly_review($1, $2, $3::jsonb, 'gpt-4.1-mini') result", [claim.id, claim.leaseToken, JSON.stringify(analysis)])).rows[0].result;
}

test("cloud planner: empty accounts, per-user isolation, no cross-account mutation", async () => {
  const initial = await call("dashboard");
  assert.deepEqual(initial.todayTasks, []);
  assert.equal(initial.activeTask, null);
  assert.equal(initial.canPlanTomorrow, false);
  assert.equal(initial.today, today);
  const task = await create();
  assert.equal(task.isPriority, true);
  assert.equal((await call("dashboard", {}, bob)).todayTasks.length, 0);
  await assert.rejects(() => call("rename_task", { id: task.id, outcome: "stolen" }, bob), /Task not found/);
  await asUser(bob, async () => {
    assert.deepEqual((await db.query("select id from public.planner_tasks")).rows, []);
    for (const table of ["planner_accounts", "planner_tasks", "planner_resources", "planner_stops", "planner_reviews"]) {
      await assert.rejects(() => db.query(`delete from public.${table}`), /permission denied/);
    }
    await assert.rejects(() => db.query("select public.planner_activity($1, $2)", [alice, week]), /permission denied/);
    await assert.rejects(() => db.query("select public.planner_review_input($1, 'UTC')", [alice]), /permission denied/);
  });
});

test("cloud planner: authentication required; anonymous sessions and bad timezones rejected", async () => {
  await db.exec("set role anon");
  try { await assert.rejects(() => db.query("select public.planner_call('dashboard')"), /permission denied/); }
  finally { await db.exec("reset role"); }
  await asUser(alice, () => assert.rejects(() => db.query("select public.planner_call('dashboard')"), /Sign in/), true);
  await assert.rejects(() => call("dashboard", {}, alice, "Not/AZone"), /timezone/);
});

test("cloud planner: limits are enforced in SQL; tomorrow unlocks after a complete nonempty day", async () => {
  await assert.rejects(() => call("create_task", { outcome: "Tomorrow", day: tomorrow, estimatedMinutes: 30 }), /Finish today/);
  const tasks = [];
  for (let i = 0; i < 3; i++) tasks.push(await create(`Task ${i}`));
  await assert.rejects(() => create("Fourth"), /no more than three/);
  await assert.rejects(() => call("start_task", { id: tasks[1].id }), /most important/);
  for (const task of tasks) {
    await call("start_task", { id: task.id });
    await call("complete_task", { id: task.id });
  }
  const dashboard = await call("dashboard");
  assert.equal(dashboard.canPlanTomorrow, true);
  assert.deepEqual(dashboard.completions, [{ day: today, count: 3 }]);
  assert.equal((await call("create_task", { outcome: "Tomorrow", day: tomorrow, estimatedMinutes: 30 })).plannedFor, tomorrow);
  await assert.rejects(() => db.query("insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes) values ($1, 'Bypass', $2, 4, 30)", [alice, today]), /check constraint/);
});

test("cloud planner: priority, estimates, titles and input validation", async () => {
  for (const outcome of ["", "x".repeat(501)]) await assert.rejects(() => create(outcome), /Invalid input/);
  for (const estimatedMinutes of [0, 61]) await assert.rejects(() => call("create_task", { outcome: "Task", day: today, estimatedMinutes }), /Invalid input/);
  await assert.rejects(() => call("create_task", { outcome: "Task", day: "not-a-date", estimatedMinutes: 30 }), /Invalid input/);
  const a = await create("Original");
  const b = await create("Second");
  assert.equal((await call("rename_task", { id: a.id, outcome: " Renamed " })).outcome, "Renamed");
  assert.equal((await call("change_estimate", { id: a.id, minutes: 45 })).estimatedMinutes, 45);
  await call("prioritize_task", { id: b.id });
  assert.equal((await call("dashboard")).todayTasks.filter((t) => t.isPriority)[0].id, b.id);
  await call("start_task", { id: b.id });
  await assert.rejects(() => call("prioritize_task", { id: a.id }), /before starting/);
  await assert.rejects(() => call("change_estimate", { id: b.id, minutes: 20 }), /unstarted/);
  // Database constraints also block direct simultaneous active tasks.
  await assert.rejects(() => db.query("update public.planner_tasks set status = 'active' where id = $1", [a.id]), /unique constraint/);
});

test("cloud planner: timer timestamps use server time; pause and reason save are atomic", async () => {
  const task = await create();
  const active = await call("start_task", { id: task.id });
  assert.ok(active.startedAt > 0);
  await db.query("update public.planner_tasks set started_at = extract(epoch from now())::bigint - 120 where id = $1", [task.id]);
  await assert.rejects(() => call("pause_task", { id: task.id, reason: "" }), /Invalid input/);
  assert.ok((await call("dashboard")).activeTask.startedAt > 0);
  const paused = await call("stop_timer", { id: task.id });
  assert.equal(paused.startedAt, null);
  assert.ok(paused.actualSeconds >= 120);
  await call("save_pause_reason", { id: task.id, reason: " Lunch " });
  assert.equal((await db.query("select reason, stopped_on::text from public.planner_stops")).rows[0].reason, "Lunch");
  await call("resume_task", { id: task.id });
  await assert.rejects(() => call("save_pause_reason", { id: task.id, reason: "Late" }), /paused/);
  const completed = await call("complete_task", { id: task.id });
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedOn, today);
  assert.equal(completed.startedAt, null);
});

test("cloud planner: paths are metadata only; resource limits, ownership and link protocols enforced", async () => {
  const task = await create();
  for (const target of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com"]) {
    await assert.rejects(() => call("add_task_link", { id: task.id, label: "bad", target }), /Invalid input/);
  }
  const result = await call("attach_task_file", { id: task.id, label: "Document", target: "/Users/me/private.pdf" });
  assert.equal(result.resources[0].kind, "file");
  const resource = result.resources[0];
  assert.equal((await call("get_task_resource", { id: task.id, resourceId: resource.id })).target, "/Users/me/private.pdf");
  await assert.rejects(() => call("get_task_resource", { id: task.id, resourceId: resource.id }, bob), /Task not found/);
  await call("remove_task_resource", { id: task.id, resourceId: resource.id });
  assert.deepEqual((await call("dashboard")).todayTasks[0].resources, []);
  for (let i = 0; i < 50; i++) await call("add_task_link", { id: task.id, label: "Link", target: "https://example.com" });
  await assert.rejects(() => call("add_task_link", { id: task.id, label: "Overflow", target: "https://example.com" }), /50 resources/);
});

test("cloud planner: AI opt-in is required and server snapshots exclude resource metadata", async () => {
  assert.equal((await call("weekly_overview")).status, "disabled");
  await assert.rejects(() => call("set_weekly_ai_enabled", { enabled: true }), /privacy notice/);
  await assert.rejects(() => call("set_weekly_ai_enabled", { enabled: "yes" }), /whether/);
  const id = await seedWeek();
  await call("attach_task_file", { id, label: "Secret", target: "/private/path.pdf" });
  const input = (await db.query("select public.planner_review_input($1, 'UTC') result", [alice])).rows[0].result;
  assert.equal(input.activity.tasks.length, 1);
  assert.ok(!JSON.stringify(input).includes("/private"));
  assert.ok(!JSON.stringify(input).includes("resources"));
  assert.equal((await call("weekly_overview")).status, "pending");
});

test("cloud planner: hosted reviews persist source snapshots durably and remain isolated by account", async () => {
  const { input, claim } = await prepareReview();
  assert.equal(claim.outcome, "reserved");
  assert.equal(await finish(claim), true);
  assert.equal(await finish(claim), false);
  const overview = await call("weekly_overview");
  assert.equal(overview.status, "up_to_date");
  assert.equal(overview.reviews.length, 1);
  assert.deepEqual(overview.reviews[0].activity, input.activity);
  assert.deepEqual(overview.reviews[0].analysis, analysis);
  assert.deepEqual((await call("weekly_overview", {}, bob)).reviews, []);
  await asUser(bob, async () => assert.deepEqual((await db.query("select * from public.planner_reviews")).rows, []));
  await db.exec("update public.ai_review_requests set generated_at = now() - interval '8 days'; select public.purge_weekly_review_content();");
  assert.equal((await call("weekly_overview")).reviews.length, 1);
});

test("cloud planner: revoking or changing consent invalidates in-flight generation", async () => {
  const { claim } = await prepareReview();
  await call("set_weekly_ai_enabled", { enabled: false });
  await call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
  assert.equal(await finish(claim), false);
  assert.equal((await call("weekly_overview")).reviews.length, 0);
  await call("set_weekly_ai_enabled", { enabled: false });
  assert.deepEqual((await db.query("select public.planner_review_input($1, 'UTC') result", [alice])).rows[0].result, { disabled: true });
});

test("cloud planner: weekly inputs bound stop samples and retain historical task context", async () => {
  await seedWeek();
  const id = (await db.query("insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, status) values ($1, 'Old active task', $2::date - 7, 1, 30, 'active') returning id", [alice, week])).rows[0].id;
  await db.query("insert into public.planner_stops(user_id, task_id, reason, stopped_at, stopped_on) select $1, $2, 'Break', 1000 + s, $3::date from generate_series(1, 201) s", [alice, id, week]);
  const input = (await db.query("select public.planner_review_input($1, 'UTC') result", [alice])).rows[0].result;
  assert.equal(input.activity.stops.length, 200);
  assert.equal(input.activity.totalStops, 201);
  assert.equal(input.activity.omittedStops, 1);
  assert.equal(input.activity.stops[0].id, 2);
  assert.ok(input.activity.tasks.some((task) => task.id === id));
  const completed = await call("complete_task", { id });
  assert.equal(completed.completedOn, today);
  assert.deepEqual((await call("dashboard")).completions, [{ day: today, count: 1 }]);
});

test("cloud planner: shared AI limits and kill switch do not affect planner writes", async () => {
  await seedWeek();
  await db.exec("update public.ai_controls set enabled = false");
  assert.equal((await call("weekly_overview")).status, "unavailable");
  await create();
  await db.exec("update public.ai_controls set enabled = true, daily_attempt_limit = 1; insert into public.ai_usage(period, attempts) values ('day:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 1)");
  assert.equal((await call("weekly_overview")).available, false);
  await create("Second task");
  assert.equal((await call("dashboard")).todayTasks.length, 2);
});

test("local queue: revisions detect concurrent edits even within the same second; receipts bypass revision checks", async () => {
  const at = Math.floor(Date.now() / 1000);
  const args = { outcome: "Original", day: today, estimatedMinutes: 10, _requestId: "40000000-0000-4000-8000-000000000001", _at: at, _revision: 0 };
  const task = await call("create_task", args);
  assert.equal(task.serverRevision, 1);
  await call("rename_task", { id: task.id, outcome: "Concurrent edit" });
  await assert.rejects(() => call("rename_task", { id: task.id, outcome: "Offline overwrite", _requestId: "40000000-0000-4000-8000-000000000002", _at: at + 10, _revision: 1 }), /another device/);
  assert.equal((await call("dashboard")).revision, 2);
  assert.deepEqual(await call("create_task", args), task);
});

test("local queue: protocol negotiation and older offline changes fail closed after newer edits", async () => {
  assert.deepEqual(await call("queue_protocol"), { version: 1 });
  const now = Math.floor(Date.now() / 1000);
  const task = await queued("create_task", { outcome: "Original", day: today, estimatedMinutes: 10 }, "30000000-0000-4000-8000-000000000001", now - 120);
  await call("rename_task", { id: task.id, outcome: "Other device" });
  await assert.rejects(() => queued("rename_task", { id: task.id, outcome: "Stale offline edit" }, "30000000-0000-4000-8000-000000000002", now - 60), /another device/);
  assert.equal((await call("dashboard")).todayTasks[0].outcome, "Other device");
  assert.equal((await db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, 1);
});

test("local queue: stable entity IDs, retry receipts, input mismatch and resource deduplication", async () => {
  const request = "10000000-0000-4000-8000-000000000001";
  const at = Math.floor(Date.now() / 1000);
  const args = { outcome: "Offline task", day: today, estimatedMinutes: 20 };
  const created = await queued("create_task", args, request, at);
  assert.equal(created.id, request);
  assert.deepEqual(await queued("create_task", args, request, at), created);
  assert.equal((await call("dashboard")).todayTasks.length, 1);
  await assert.rejects(() => queued("create_task", { ...args, outcome: "Changed" }, request, at), /reused/);
  const linkId = "10000000-0000-4000-8000-000000000002";
  const linkArgs = { id: request, label: "Docs", target: "https://example.com" };
  const linked = await queued("add_task_link", linkArgs, linkId, at);
  assert.equal(linked.resources[0].id, linkId);
  assert.deepEqual(await queued("add_task_link", linkArgs, linkId, at), linked);
  await asUser(alice, () => assert.rejects(() => db.query("select public.planner_execute('dashboard')"), /permission denied/));
  await asUser(bob, () => assert.rejects(() => db.query("select * from public.planner_receipts"), /permission denied/));
  assert.equal((await queued("create_task", args, "10000000-0000-4000-8000-000000000003", at, bob)).outcome, args.outcome);
});

test("local queue: timer events preserve action time; stale/future commands and injected internals are rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const task = await queued("create_task", { outcome: "Timer", day: today, estimatedMinutes: 30 }, id(10), now - 301);
  await queued("start_task", { id: task.id }, id(1), now - 300);
  const paused = await queued("stop_timer", { id: task.id }, id(2), now - 180);
  assert.equal(paused.actualSeconds, 120);
  assert.equal(paused.startedAt, null);
  await queued("save_pause_reason", { id: task.id, reason: "A break" }, id(3), now - 179);
  await queued("resume_task", { id: task.id }, id(4), now - 60);
  const completed = await queued("complete_task", { id: task.id }, id(5), now - 10);
  assert.equal(completed.actualSeconds, 170);
  assert.deepEqual(await queued("complete_task", { id: task.id }, id(5), now - 10), completed);
  assert.equal((await db.query("select count(*)::int n from public.planner_stops")).rows[0].n, 1);
  await assert.rejects(() => queued("rename_task", { id: task.id, outcome: "Future" }, id(6), now + 3600), /clock/);
  await assert.rejects(() => queued("rename_task", { id: task.id, outcome: "Old" }, id(7), now - 31 * 86400), /30 days/);
  const plain = await call("create_task", { outcome: "Online", day: today, estimatedMinutes: 1, _eventTime: now - 86400, _entityId: id(8) });
  assert.notEqual(plain.id, id(8));
  assert.equal(plain.plannedFor, today);
});

test("cloud planner: empty weeks make no AI input; cloud data is removed on Auth user deletion", async () => {
  assert.equal((await call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" })).status, "no_data");
  await create();
  await db.query("delete from auth.users where id = $1", [alice]);
  assert.equal((await db.query("select count(*)::integer c from public.planner_tasks")).rows[0].c, 0);
  await db.query("insert into auth.users values ($1)", [alice]);
});
