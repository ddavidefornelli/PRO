import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ALICE, BOB, database, seededRandom, uuid } from "../helpers/database.mjs";

let f;
before(async () => { f = await database(); });
after(async () => { await f?.db.close(); });
beforeEach(async () => { await f.reset(); });
const taskArgs = () => ({ outcome: "A real outcome", day: f.dates.today, estimatedMinutes: 30 });
async function state() {
  const result = {};
  for (const table of ["planner_accounts", "planner_tasks", "planner_stops", "planner_resources", "planner_receipts"]) {
    result[table] = (await f.db.query(`select * from public.${table} order by 1`)).rows;
  }
  return result;
}

const invalidCreates = [
  ["missing title", { outcome: undefined }], ["null title", { outcome: null }],
  ["empty title", { outcome: "" }], ["blank title", { outcome: "    " }],
  ["long title", { outcome: "x".repeat(501) }], ["missing day", { day: undefined }],
  ["null day", { day: null }], ["invalid day", { day: "not-a-date" }],
  ["impossible date", { day: "2026-02-30" }], ["past day", { day: "2000-01-01" }],
  ["future day", { day: "2099-12-31" }], ["zero estimate", { estimatedMinutes: 0 }],
  ["negative estimate", { estimatedMinutes: -1 }], ["oversized estimate", { estimatedMinutes: 61 }],
  ["fractional estimate", { estimatedMinutes: 1.5 }], ["null estimate", { estimatedMinutes: null }],
  ["missing estimate", { estimatedMinutes: undefined }], ["huge estimate", { estimatedMinutes: 1e40 }],
  ["nonnumeric estimate", { estimatedMinutes: "thirty" }], ["boolean estimate", { estimatedMinutes: true }],
];
for (const [name, change] of invalidCreates) {
  test(`SQL invalid creation: ${name} rolls back all state`, async () => {
    await f.call("dashboard");
    const before = await state();
    await assert.rejects(() => f.call("create_task", { ...taskArgs(), ...change }), (error) => error.code === "PT400");
    assert.deepEqual(await state(), before);
  });
}
for (const args of [null, [], "text", 42, true, { padding: "x".repeat(20001) }]) {
  test(`SQL rejects nonobject/oversized arguments: ${JSON.stringify(args).slice(0, 30)}`, async () => {
    await assert.rejects(() => f.call("dashboard", args), (error) => error.code === "PT400");
    assert.deepEqual((await f.db.query("select * from public.planner_accounts")).rows, []);
  });
}
for (const value of [1, 60]) {
  test(`SQL inclusive estimate boundary: ${value} minutes and 500 Unicode characters`, async () => {
    const task = await f.call("create_task", { ...taskArgs(), estimatedMinutes: value, outcome: "🧪".repeat(500) });
    assert.equal(task.estimatedMinutes, value);
    assert.equal([...task.outcome].length, 500);
  });
}

const transitions = {
  start_task: ["planned"], pause_task: ["running"], stop_timer: ["running"],
  save_pause_reason: ["paused"], resume_task: ["paused"], complete_task: ["running", "paused"],
  change_estimate: ["planned"], prioritize_task: ["planned"], rename_task: ["planned", "running", "paused", "completed"],
};
for (const status of ["planned", "running", "paused", "completed"]) {
  for (const [action, allowed] of Object.entries(transitions)) {
    test(`SQL transition matrix: ${status} → ${action}`, async () => {
      const task = await f.create();
      if (status !== "planned") await f.call("start_task", { id: task.id });
      if (status === "paused") await f.call("stop_timer", { id: task.id });
      if (status === "completed") await f.call("complete_task", { id: task.id });
      const before = await state();
      const invoke = () => f.call(action, { id: task.id, reason: "Lunch", minutes: 15, outcome: "Rewritten" });
      if (allowed.includes(status)) {
        const result = await invoke();
        assert.equal(result.id, task.id);
        assert.equal(result.serverRevision, before.planner_accounts[0].revision + 1);
      } else {
        await assert.rejects(invoke, (error) => error.code === "PT409");
        assert.deepEqual(await state(), before, "rejected transitions must not change revisions, stops or timers");
      }
    });
  }
}

const taskActions = ["rename_task", "change_estimate", "prioritize_task", "start_task", "pause_task", "stop_timer", "save_pause_reason", "resume_task", "complete_task", "add_task_link", "attach_task_file", "remove_task_resource", "get_task_resource"];
for (const action of taskActions) {
  test(`SQL account boundary: ${action} cannot touch another user's task/resources`, async () => {
    const task = await f.create("Alice's private outcome");
    const before = await state();
    await assert.rejects(() => f.call(action, { id: task.id, resourceId: uuid(99), reason: "stolen", outcome: "stolen", minutes: 10, label: "stolen", target: "https://example.com" }, BOB), (error) => error.code === "PT404");
    assert.deepEqual(await state(), before);
  });
}
for (const role of ["anon", "authenticated"]) {
  for (const operation of ["insert", "update", "delete"]) {
    test(`SQL privileges: ${role} cannot ${operation} any planner/operational table`, async () => {
      for (const table of ["planner_accounts", "planner_tasks", "planner_stops", "planner_resources", "planner_reviews", "planner_receipts", "ai_controls", "ai_usage", "ai_review_requests"]) {
        const sql = operation === "insert" ? `insert into public.${table} default values` : operation === "update" ? `update public.${table} set ${table === "ai_controls" ? "enabled = false" : table === "ai_usage" ? "attempts = 0" : "user_id = user_id"}` : `delete from public.${table}`;
        await assert.rejects(() => f.as(ALICE, (tx) => tx.exec(sql), role), /permission denied/);
      }
    });
  }
}

test("SQL timer and reason validation are one transaction, including revision/receipt writes", async () => {
  const task = await f.create();
  await f.call("start_task", { id: task.id });
  for (const reason of [null, "", " ", "x".repeat(1001)]) {
    const before = await state();
    await assert.rejects(() => f.call("pause_task", { id: task.id, reason, _requestId: uuid(3), _at: Math.floor(Date.now() / 1000) + 2 }), (error) => error.code === "PT400");
    assert.deepEqual(await state(), before);
  }
  await f.call("pause_task", { id: task.id, reason: "🧪".repeat(1000) });
  const before = await state();
  await assert.rejects(() => f.call("save_pause_reason", { id: task.id, reason: "" }), /Invalid input/);
  assert.deepEqual(await state(), before);
});

test("SQL partial progress never unlocks tomorrow and a paused task still owns the active slot", async () => {
  const a = await f.create("Priority"), b = await f.create("Second");
  await f.call("start_task", { id: a.id }); await f.call("stop_timer", { id: a.id });
  await assert.rejects(() => f.call("start_task", { id: b.id }), /no other active task/);
  assert.equal((await f.call("dashboard")).canPlanTomorrow, false);
  await f.call("complete_task", { id: a.id });
  await assert.rejects(() => f.call("create_task", { ...taskArgs(), day: f.dates.tomorrow }), /Finish today/);
  await f.call("start_task", { id: b.id }); await f.call("complete_task", { id: b.id });
  const next = await f.call("create_task", { ...taskArgs(), day: f.dates.tomorrow });
  await assert.rejects(() => f.call("start_task", { id: next.id }), /today/);
});

for (const timezone of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/Rome", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe"]) {
  test(`SQL queued overnight workflow preserves captured dates and elapsed time: ${timezone}`, async () => {
    const midnight = Number((await f.db.query("select extract(epoch from ((date_trunc('day', now() at time zone $1) - interval '1 day') at time zone $1))::bigint::text n", [timezone])).rows[0].n);
    const localDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at * 1000));
    const call = (action, args, n, at) => f.call(action, { ...args, _requestId: uuid(n), _at: at, _revision: n - 1 }, ALICE, timezone);
    const task = await call("create_task", { ...taskArgs(), day: localDate(midnight - 60) }, 1, midnight - 60);
    await call("start_task", { id: task.id }, 2, midnight - 60);
    await call("pause_task", { id: task.id, reason: "Midnight break" }, 3, midnight + 60);
    await call("resume_task", { id: task.id }, 4, midnight + 120);
    const completed = await call("complete_task", { id: task.id }, 5, midnight + 150);
    assert.equal(completed.actualSeconds, 150);
    assert.equal(completed.completedOn, localDate(midnight + 150));
    assert.equal((await f.db.query("select stopped_on::text d from public.planner_stops")).rows[0].d, completed.completedOn);
    assert.deepEqual((await f.call("dashboard")).completions, [{ day: completed.completedOn, count: 1 }]);
  });
}

for (const [name, change] of [
  ["action", { action: "rename_task" }], ["args", { args: { ...{ outcome: "Changed", estimatedMinutes: 30 }, day: null } }],
  ["timezone", { timezone: "Europe/Rome" }], ["timestamp", { at: 1 }], ["revision", { revision: 12 }],
]) {
  test(`SQL receipt identity cannot be reused with different ${name}`, async () => {
    const original = { action: "create_task", args: taskArgs(), timezone: "UTC", at: Number(f.dates.epoch), revision: 0 };
    const send = (cmd) => f.call(cmd.action, { ...cmd.args, _requestId: uuid(1), _at: cmd.at, _revision: cmd.revision }, ALICE, cmd.timezone);
    const result = await send(original), before = await state();
    await assert.rejects(() => send({ ...original, ...change }), /reused/);
    assert.deepEqual(await send(original), result);
    assert.deepEqual(await state(), before);
  });
}
for (const [name, args] of [
  ["null identity", { _requestId: null, _at: 1 }], ["malformed identity", { _requestId: "nope", _at: 1 }],
  ["missing timestamp", { _requestId: uuid(1) }], ["fractional timestamp", { _requestId: uuid(1), _at: 1.5 }],
  ["null revision", { _requestId: uuid(1), _at: Date.now() / 1000 | 0, _revision: null }],
  ["fractional revision", { _requestId: uuid(1), _at: Date.now() / 1000 | 0, _revision: 0.5 }],
]) {
  test(`SQL malformed queue envelope: ${name} cannot commit anything`, async () => {
    const before = await state();
    await assert.rejects(() => f.call("create_task", { ...taskArgs(), ...args }), (error) => ["PT400", "PT409"].includes(error.code));
    assert.deepEqual(await state(), before);
  });
}

test("SQL all queued mutations deduplicate after a lost response, not just creation", async () => {
  let n = 0, revision = 0;
  const send = async (action, args) => {
    const envelope = { ...args, _requestId: uuid(++n), _at: Number(f.dates.epoch) + 2, _revision: revision };
    const first = await f.call(action, envelope);
    const before = await state();
    assert.deepEqual(await f.call(action, envelope), first);
    assert.deepEqual(await state(), before);
    revision++;
    assert.equal(first.serverRevision, revision);
    return first;
  };
  let task = await send("create_task", taskArgs());
  await send("rename_task", { id: task.id, outcome: "Edited" });
  await send("change_estimate", { id: task.id, minutes: 60 });
  await send("prioritize_task", { id: task.id });
  task = await send("add_task_link", { id: task.id, label: "Reference", target: "https://example.com/docs" });
  await send("remove_task_resource", { id: task.id, resourceId: task.resources[0].id });
  await send("start_task", { id: task.id });
  await send("pause_task", { id: task.id, reason: "Lunch" });
  await send("save_pause_reason", { id: task.id, reason: "Lunch with family" });
  await send("resume_task", { id: task.id });
  await send("stop_timer", { id: task.id });
  await send("complete_task", { id: task.id });
  assert.equal((await f.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, n);
  assert.equal((await f.db.query("select count(*)::int n from public.planner_stops")).rows[0].n, 2);
});

test("SQL seeded adversarial command storm preserves invariants after every commit/rejection (400 actions)", async () => {
  const random = seededRandom(0x5eedcafe), ids = [];
  const actions = ["start_task", "pause_task", "resume_task", "complete_task", "change_estimate", "prioritize_task", "rename_task", "save_pause_reason"];
  let rejected = 0;
  for (let i = 0; i < 400; i++) {
    const id = ids[Math.floor(random() * ids.length)] ?? uuid(999);
    try {
      if (random() < 0.07) ids.push((await f.create(`Outcome ${i}`)).id);
      else await f.call(actions[Math.floor(random() * actions.length)], { id, reason: i % 7 ? "A necessary break" : "", minutes: Math.floor(random() * 64), outcome: `Rewritten ${i}` });
    } catch (error) { assert.ok(["PT400", "PT404", "PT409"].includes(error.code), error.message); rejected++; }
    const rows = (await f.db.query("select * from public.planner_tasks")).rows;
    assert.ok(rows.length <= 3);
    assert.ok(rows.filter((t) => t.status === "active").length <= 1);
    assert.ok(rows.filter((t) => t.is_priority).length <= 1);
    for (const task of rows) {
      assert.ok(task.actual_seconds >= 0);
      assert.ok(task.started_at === null || task.status === "active");
      assert.equal(task.completed_on !== null, task.status === "completed");
    }
  }
  assert.ok(ids.length > 0 && rejected > 150, "exercise successes and failures, not a vacuous random loop");
});
