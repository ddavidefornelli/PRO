import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalQueue, project } from "../src/local-queue.ts";
import { dashboard, deferred, offline, persistence } from "./helpers/queue.mjs";
import { seededRandom } from "./helpers/database.mjs";

function fixture() {
  const p = persistence();
  const base = dashboard();
  const key = "fixture:alice";
  const seed = (pending = [], blocked = null) => p.storage.setItem(key, JSON.stringify({ version: 1, base, savedAt: Date.now() / 1000, pending, blocked }));
  seed();
  const make = (send = offline, fetch = async () => structuredClone(base), queueKey = key) => new LocalQueue(queueKey, p.storage, p.lock, send, fetch);
  const create = { outcome: "Offline outcome", day: base.today, estimatedMinutes: 30 };
  return { ...p, base, key, seed, make, create };
}

for (const raw of ["{broken", "null", JSON.stringify({ version: 2, pending: [] }), JSON.stringify({ version: 1, pending: {} })]) {
  test(`queue refuses corrupt/unknown storage without overwriting it: ${raw}`, () => {
    const f = fixture(); f.storage.setItem(f.key, raw);
    assert.throws(() => f.make()); assert.equal(f.storage.getItem(f.key), raw);
  });
}

test("queue cannot enqueue without an initial authenticated dashboard", async () => {
  const f = fixture(), q = f.make(offline, undefined, "uncached");
  await assert.rejects(() => q.enqueue("create_task", f.create, "UTC"), /Connect once/);
  assert.equal(q.pendingCount, 0); assert.equal(q.snapshot(), null); await q.stop();
});

test("queue is isolated by full project AND immutable account key", async () => {
  const f = fixture(), q = f.make();
  await q.enqueue("create_task", f.create, "UTC"); await q.stop();
  for (const key of ["https://one.supabase.co:alice", "https://two.supabase.co:alice", "https://one.supabase.co:bob"]) {
    const other = f.make(offline, undefined, key);
    assert.equal(other.pendingCount, 0); assert.equal(other.snapshot(), null); await other.stop();
  }
  const original = f.make(); assert.equal(original.pendingCount, 1); await original.stop();
  const raw = f.storage.getItem(f.key);
  assert.ok(!raw.includes("access_token") && !raw.includes("refresh_token"));
});

test("queue rejects unknown tasks and rolls back the entire storage transaction", async () => {
  const f = fixture(), q = f.make(), saved = f.storage.getItem(f.key);
  await assert.rejects(() => q.enqueue("rename_task", { id: "missing", outcome: "Lost" }, "UTC"), /not available/);
  assert.equal(f.storage.getItem(f.key), saved); assert.equal(q.pendingCount, 0); await q.stop();
});

test("queue returned objects and snapshots cannot mutate durable pending actions", async () => {
  const f = fixture(), q = f.make();
  const args = { ...f.create }, task = await q.enqueue("create_task", args, "UTC");
  args.outcome = "Changed by caller"; task.outcome = "Changed returned task";
  const first = q.snapshot(); first.todayTasks[0].outcome = "Mutated snapshot";
  assert.equal(q.snapshot().todayTasks[0].outcome, f.create.outcome);
  assert.equal(JSON.parse(f.storage.getItem(f.key)).pending[0].args.outcome, f.create.outcome); await q.stop();
});

test("queue stopped state refuses writes and performs no HTTP calls; explicit resume restores syncing", async () => {
  const f = fixture(); let calls = 0;
  const q = f.make(async () => { calls++; throw { code: "network", message: "offline" }; });
  await q.stop(); await q.sync();
  await assert.rejects(() => q.enqueue("create_task", f.create, "UTC"), /closed/); assert.equal(calls, 0);
  q.resume(); await q.enqueue("create_task", f.create, "UTC"); await q.sync();
  assert.equal(calls, 1); await q.stop();
});

test("queue sync single-flight shares one promise and stop waits for the in-flight acknowledgement", async () => {
  const f = fixture(), gate = deferred(), started = deferred(); let calls = 0;
  const q = f.make(async (command) => { calls++; started.resolve(); await gate.promise; return project(f.base, command).todayTasks[0]; });
  await q.enqueue("create_task", f.create, "UTC");
  await started.promise;
  const first = q.sync(); assert.equal(q.sync(), first);
  let stopped = false; const stopping = q.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(stopped, false);
  gate.resolve(); await stopping;
  assert.equal(calls, 1); assert.equal(q.pendingCount, 0);
});

for (const code of ["network", "server", "rate_limited", "configuration", "unauthorized", "credentials"]) {
  test(`queue ambiguous ${code} failures retain identical IDs and are never discardable`, async () => {
    const f = fixture(), attempts = [];
    const q = f.make(async (command) => { attempts.push(structuredClone(command)); throw { code, message: "Try later" }; });
    await q.enqueue("create_task", f.create, "UTC"); await q.sync();
    assert.equal(q.blocked, false); assert.equal(q.pendingCount, 1);
    await assert.rejects(() => q.discardPending(), /Only rejected/);
    await q.sync(); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    await q.stop();
  });
}

test("queue backoff is exponential and capped at 60 seconds; stop cancels retry timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); let attempts = 0;
  const q = f.make(async () => { attempts++; throw { code: "network", message: "Offline" }; });
  await q.enqueue("create_task", f.create, "UTC"); await q.sync();
  assert.equal(attempts, 1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    t.mock.timers.tick(delay - 1); await new Promise((resolve) => setImmediate(resolve));
    const before = attempts;
    t.mock.timers.tick(1); await q.sync(); assert.equal(attempts, before + 1);
  }
  await q.stop(); const before = attempts;
  t.mock.timers.tick(1_000_000); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, before);
});

test("queue ack storage failure retains the request; restart retries the committed receipt safely", async () => {
  const f = fixture(), receipts = new Map(); let failSave = true, writes = 0;
  const send = async (command) => {
    if (!receipts.has(command.requestId)) { writes++; receipts.set(command.requestId, project(f.base, command).todayTasks[0]); }
    if (failSave) { f.storage.setItem = () => { throw new Error("Disk full during acknowledgement"); }; }
    return receipts.get(command.requestId);
  };
  const normalSave = f.storage.setItem, q = f.make(send);
  await q.enqueue("create_task", f.create, "UTC"); await q.sync();
  assert.equal(q.pendingCount, 1); assert.equal(writes, 1); await q.stop();
  f.storage.setItem = normalSave; failSave = false;
  const restarted = f.make(send, async () => ({ ...f.base, revision: 1, todayTasks: [...receipts.values()] }));
  await restarted.sync(); assert.equal(restarted.pendingCount, 0); assert.equal(writes, 1); await restarted.stop();
});

for (const [name, response] of [["null", null], ["empty object", {}], ["string", "ok"], ["wrong task ID", { id: "wrong-task" }]]) {
  test(`queue malformed success acknowledgement (${name}) must never remove durable work`, async () => {
    const f = fixture(), q = f.make(async () => response);
    await q.enqueue("create_task", f.create, "UTC"); await q.sync();
    assert.equal(q.pendingCount, 1);
    assert.equal(JSON.parse(f.storage.getItem(f.key)).pending.length, 1);
    assert.equal(q.blocked, false, "a broken response is ambiguous, not a definitive rejection");
    await q.stop();
  });
}

for (const [field, value] of [
  ["outcome", null], ["plannedFor", null], ["isPriority", 1], ["estimatedMinutes", 1.5],
  ["actualSeconds", -1], ["actualSeconds", "0"], ["createdAt", null], ["status", "deleted"],
  ["startedAt", "now"], ["completedOn", 42], ["resources", null],
  ["resources", [{ id: "r", label: "bad", target: "target", kind: "executable" }]], ["serverRevision", 999],
]) {
  test(`queue incomplete/mismatched acknowledgement field ${field}=${JSON.stringify(value)} preserves the outbox`, async (t) => {
    const f = fixture(), queue = f.make(async (command) => ({ ...project(f.base, command).todayTasks[0], [field]: value }));
    t.after(() => queue.stop());
    await queue.enqueue("create_task", f.create, "UTC"); await queue.sync();
    assert.equal(queue.pendingCount, 1); assert.equal(queue.blocked, false);
  });
}

test("queue stale window cannot discard a new ambiguous request after another window resolves the conflict", async () => {
  const f = fixture(); f.seed([], "A definitively rejected action");
  const stale = f.make(), current = f.make();
  await current.discardPending(); await current.sync();
  await current.enqueue("create_task", f.create, "UTC"); await current.sync();
  assert.equal(current.pendingCount, 1);
  const saved = f.storage.getItem(f.key);
  await assert.rejects(() => stale.discardPending(), /Only rejected/);
  assert.equal(f.storage.getItem(f.key), saved, "a stale blocked flag must never authorize deleting new unsynced work");
  await current.stop(); await stale.stop();
});

test("queue completing yesterday's active task returns the completed task even after it leaves the dashboard", async (t) => {
  const at = Date.parse("2026-10-13T00:01:00Z") / 1000;
  t.mock.timers.enable({ apis: ["Date"], now: at * 1000 });
  const f = fixture();
  const task = { id: "overnight", outcome: "Yesterday's focus", plannedFor: "2026-10-12", estimatedMinutes: 30,
    actualSeconds: 60, status: "active", startedAt: at - 120, completedOn: null, createdAt: at - 1000, isPriority: true, resources: [] };
  f.base.activeTask = task;
  f.seed();
  const queue = f.make(); t.after(() => queue.stop());
  const completed = await queue.enqueue("complete_task", { id: task.id }, "UTC");
  assert.equal(completed.id, task.id);
  assert.equal(completed.status, "completed"); assert.equal(completed.actualSeconds, 180);
  assert.equal(completed.completedOn, "2026-10-13");
  assert.equal(queue.snapshot().activeTask, null);
  assert.deepEqual(queue.snapshot().completions, [{ day: "2026-10-13", count: 1 }]);
});

for (const [name, start, pause, resume, end, seconds] of [
  ["spring DST gap", "2026-03-08T06:55:00Z", "2026-03-08T07:05:00Z", "2026-03-08T07:20:00Z", "2026-03-08T07:30:00Z", 1200],
  ["autumn DST repeated hour", "2026-11-01T05:55:00Z", "2026-11-01T06:05:00Z", "2026-11-01T06:20:00Z", "2026-11-01T06:30:00Z", 1200],
  ["sleep and closed app", "2026-10-12T05:00:00Z", "2026-10-12T14:00:00Z", "2026-10-12T16:00:00Z", "2026-10-12T17:00:00Z", 36000],
]) {
  test(`queue projection uses epoch time across ${name}`, () => {
    const epoch = (v) => Date.parse(v) / 1000;
    let base = dashboard(epoch(start)); const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(start));
    const cmd = (action, at, args = {}) => ({ action, at: epoch(at), timezone: "America/New_York", requestId: "t", args: { id: "t", ...args }, revision: 0 });
    base = project(base, cmd("create_task", start, { day, outcome: "DST work", estimatedMinutes: 30 }));
    base = project(base, cmd("start_task", start)); base = project(base, cmd("pause_task", pause));
    base = project(base, cmd("resume_task", resume)); base = project(base, cmd("complete_task", end));
    assert.equal(base.todayTasks[0].actualSeconds, seconds);
    assert.equal(base.activeTask, null); assert.equal(base.completions[0].count, 1);
  });
}
for (const seed of [1, 42, 0xdeadbeef, 0x5eed]) {
  test(`queue independent timer oracle with 100 pause/resume segments (seed ${seed})`, () => {
    const random = seededRandom(seed); let at = Date.parse("2026-10-12T08:00:00Z") / 1000;
    let base = dashboard(at), elapsed = 0;
    const cmd = (action, args = {}) => ({ action, args: { id: "t", ...args }, at, requestId: "t", revision: 0, timezone: "UTC" });
    base = project(base, cmd("create_task", { outcome: "Long day", day: base.today, estimatedMinutes: 60 }));
    base = project(base, cmd("start_task"));
    for (let i = 0; i < 100; i++) {
      const work = Math.floor(random() * 60); at += work; elapsed += work;
      base = project(base, cmd("pause_task")); assert.equal(base.activeTask.actualSeconds, elapsed);
      at += Math.floor(random() * 120); base = project(base, cmd("resume_task"));
    }
    base = project(base, cmd("complete_task")); assert.equal(base.todayTasks[0].actualSeconds, elapsed);
  });
}
