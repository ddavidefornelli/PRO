import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { LocalQueue } from "../../src/local-queue.ts";
import { ALICE, BOB, database } from "../helpers/database.mjs";
import { deferred, offline, persistence } from "../helpers/queue.mjs";

let f;
before(async () => { f = await database(); });
after(async () => { await f?.db.close(); });
beforeEach(async () => { await f.reset(); });

async function fixture() {
  const p = persistence(), queues = [], attempts = [];
  const send = async (command) => {
    attempts.push(structuredClone(command));
    try {
      return await f.call(command.action, { ...command.args, _requestId: command.requestId, _at: command.at, _revision: command.revision }, ALICE, command.timezone);
    } catch (error) {
      if (error.code?.startsWith("PT")) throw { code: "validation", message: error.message };
      throw error;
    }
  };
  const make = (sender = send, key = "project:alice", fetch = () => f.call("dashboard")) => {
    const q = new LocalQueue(key, p.storage, p.lock, sender, fetch); queues.push(q); return q;
  };
  const initial = make(); await initial.sync(); await initial.stop();
  return { ...p, make, send, attempts, close: () => Promise.all(queues.map((q) => q.stop())) };
}
const createArgs = () => ({ outcome: "Offline task", day: f.dates.today, estimatedMinutes: 30 });

test("real SQL + queue: complete offline day, resource dependencies, restart, lost response, then plan tomorrow", async (t) => {
  const qf = await fixture(); t.after(qf.close);
  const offlineQueue = qf.make(offline);
  const first = await offlineQueue.enqueue("create_task", createArgs(), "UTC");
  const second = await offlineQueue.enqueue("create_task", { ...createArgs(), outcome: "Second" }, "UTC");
  await offlineQueue.enqueue("rename_task", { id: first.id, outcome: "Polished outcome" }, "UTC");
  await offlineQueue.enqueue("change_estimate", { id: first.id, minutes: 60 }, "UTC");
  const withLink = await offlineQueue.enqueue("add_task_link", { id: first.id, label: "Docs", target: "https://example.com/docs" }, "UTC");
  await offlineQueue.enqueue("remove_task_resource", { id: first.id, resourceId: withLink.resources[0].id }, "UTC");
  await offlineQueue.enqueue("start_task", { id: first.id }, "UTC");
  await offlineQueue.enqueue("stop_timer", { id: first.id }, "UTC");
  await offlineQueue.enqueue("save_pause_reason", { id: first.id, reason: "Lunch and a short walk" }, "UTC");
  await offlineQueue.enqueue("resume_task", { id: first.id }, "UTC");
  await offlineQueue.enqueue("complete_task", { id: first.id }, "UTC");
  await offlineQueue.enqueue("start_task", { id: second.id }, "UTC");
  await offlineQueue.enqueue("complete_task", { id: second.id }, "UTC");
  await offlineQueue.enqueue("create_task", { ...createArgs(), day: f.dates.tomorrow, outcome: "Tomorrow's outcome" }, "UTC");
  await offlineQueue.sync();
  const expected = offlineQueue.snapshot();
  assert.equal(expected.canPlanTomorrow, true); assert.equal(expected.tomorrowTasks.length, 1);
  assert.equal((await f.call("dashboard")).todayTasks.length, 0);
  await offlineQueue.stop();
  let lost = true;
  const restarted = qf.make(async (cmd) => {
    const result = await qf.send(cmd);
    if (lost) { lost = false; throw { code: "network", message: "Committed, response lost" }; }
    return result;
  });
  await restarted.sync(); assert.equal(restarted.pendingCount, 14);
  await restarted.sync();
  assert.equal(restarted.pendingCount, 0); assert.equal(restarted.blocked, false);
  const actual = await f.call("dashboard");
  const comparable = (d) => ({ revision: d.revision, todayTasks: d.todayTasks.map(({ createdAt, ...rest }) => rest), tomorrowTasks: d.tomorrowTasks.map(({ createdAt, ...rest }) => rest), completions: d.completions, canPlanTomorrow: d.canPlanTomorrow, activeTask: d.activeTask });
  assert.deepEqual(comparable(actual), comparable(expected));
  assert.equal((await f.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, 14);
  assert.equal((await f.db.query("select reason from public.planner_stops")).rows[0].reason, "Lunch and a short walk");
  assert.deepEqual((await f.call("dashboard", {}, BOB)).todayTasks, []);
});

test("real SQL + queue: mid-replay rejection preserves successful prefix; discard removes only dependent suffix", async (t) => {
  const qf = await fixture(); t.after(qf.close);
  const offlineQueue = qf.make(offline);
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push(await offlineQueue.enqueue("create_task", { ...createArgs(), outcome: `Task ${i}` }, "UTC"));
  await offlineQueue.enqueue("rename_task", { id: tasks[3].id, outcome: "Depends on rejected fourth task" }, "UTC");
  await offlineQueue.stop();
  const queue = qf.make(); await queue.sync();
  assert.equal(queue.blocked, true); assert.equal(queue.pendingCount, 2);
  assert.equal((await f.call("dashboard")).todayTasks.length, 3);
  await queue.discardPending(); await queue.sync();
  assert.equal(queue.pendingCount, 0); assert.equal(queue.snapshot().todayTasks.length, 3);
  assert.equal((await f.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, 3);
});

test("real SQL + queue: unseen cross-device mutation stops offline overwrite even in the same second", async (t) => {
  const qf = await fixture(); t.after(qf.close);
  const online = qf.make(); const task = await online.enqueue("create_task", createArgs(), "UTC"); await online.sync(); await online.stop();
  const queue = qf.make(offline);
  await queue.enqueue("rename_task", { id: task.id, outcome: "Offline rewrite" }, "UTC"); await queue.stop();
  await f.call("rename_task", { id: task.id, outcome: "Other device rewrite" });
  const restarted = qf.make(); await restarted.sync();
  assert.equal(restarted.blocked, true); assert.equal(restarted.pendingCount, 1);
  assert.equal((await f.call("dashboard")).todayTasks[0].outcome, "Other device rewrite");
});

test("real SQL + queue: 12 windows race local task creation; SQL caps successful replay at three", async (t) => {
  const qf = await fixture(); t.after(qf.close);
  const windows = Array.from({ length: 12 }, () => qf.make());
  await Promise.all(windows.map((q, i) => q.enqueue("create_task", { ...createArgs(), outcome: `Window ${i}` }, "UTC")));
  await Promise.all(windows.map((q) => q.sync()));
  const dashboard = await f.call("dashboard");
  assert.equal(dashboard.todayTasks.length, 3); assert.equal(dashboard.revision, 3);
  const stored = JSON.parse(qf.storage.getItem("project:alice"));
  assert.equal(stored.pending.length, 9); assert.match(stored.blocked, /three/);
  assert.equal((await f.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n, 3);
});

test("real SQL + queue: enqueues during the actual transaction HTTP wait retain revision ordering", async (t) => {
  const qf = await fixture(); t.after(qf.close);
  const gate = deferred();
  const queue = qf.make(async (command) => { await gate.promise; return qf.send(command); });
  const task = await queue.enqueue("create_task", createArgs(), "UTC");
  await queue.enqueue("rename_task", { id: task.id, outcome: "Edited in flight" }, "UTC");
  await queue.enqueue("start_task", { id: task.id }, "UTC");
  gate.resolve(); await queue.sync();
  assert.equal(queue.pendingCount, 0); assert.deepEqual(qf.attempts.map((c) => c.revision), [0, 1, 2]);
  const actual = await f.call("dashboard"); assert.equal(actual.activeTask.outcome, "Edited in flight"); assert.equal(actual.revision, 3);
});
