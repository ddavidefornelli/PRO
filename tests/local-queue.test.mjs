import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalQueue, project } from "../src/local-queue.ts";
import { deferred, persistence } from "./helpers/queue.mjs";

const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const dashboard = () => ({ today: day, tomorrow, todayTasks: [], tomorrowTasks: [], activeTask: null,
  canPlanTomorrow: false, completions: [], serverNow: Math.floor(Date.now() / 1000) });
const args = { outcome: "Local work", day, estimatedMinutes: 15 };
function fixture() {
  const { storage, lock } = persistence();
  let server = dashboard();
  const receipts = new Map();
  const attempts = [];
  const execute = async (command) => {
    attempts.push(command);
    if (receipts.has(command.requestId)) return receipts.get(command.requestId);
    if (command.revision !== (server.revision ?? 0)) throw { code: "validation", message: "Planner revision changed" };
    server = project(server, command);
    const task = [...server.todayTasks, ...server.tomorrowTasks, ...(server.activeTask ? [server.activeTask] : [])]
      .find((item) => item.id === (command.action === "create_task" ? command.requestId : command.args.id));
    receipts.set(command.requestId, structuredClone(task));
    return structuredClone(task);
  };
  const make = (send = execute, key = "alice", fetch = async () => structuredClone(server)) => new LocalQueue(key, storage, lock, send, fetch);
  return { storage, make, execute, attempts, server: () => server };
}
const network = () => Promise.reject({ code: "network", message: "Offline" });

test("persistent queue: immediate local result, restart recovery, account isolation, ordered dependent actions", async () => {
  const f = fixture();
  const queue = f.make();
  await queue.sync();
  await queue.stop();
  const offline = f.make(network);
  const task = await offline.enqueue("create_task", args, "UTC");
  await offline.enqueue("rename_task", { id: task.id, outcome: "Edited offline" }, "UTC");
  await offline.sync();
  assert.equal(offline.snapshot().todayTasks[0].outcome, "Edited offline");
  assert.equal(offline.pendingCount, 2);
  assert.equal(f.server().todayTasks.length, 0);
  await offline.stop();
  const otherAccount = f.make(network, "bob");
  assert.equal(otherAccount.snapshot(), null);
  await otherAccount.stop();
  const restarted = f.make();
  assert.equal(restarted.snapshot().todayTasks[0].id, task.id);
  await restarted.sync();
  assert.equal(restarted.pendingCount, 0);
  assert.equal(f.server().todayTasks[0].outcome, "Edited offline");
  assert.deepEqual(f.attempts.map((command) => command.action), ["create_task", "rename_task"]);
  await restarted.stop();
});

test("persistent queue: lost acknowledgements retry the identical request without duplicating work", async () => {
  const f = fixture();
  const queue = f.make(); await queue.sync(); await queue.stop();
  let lost = true;
  const client = f.make(async (command) => {
    const result = await f.execute(command);
    if (lost) { lost = false; throw { code: "network", message: "Response lost" }; }
    return result;
  });
  const task = await client.enqueue("create_task", args, "UTC");
  await client.sync();
  assert.equal(client.pendingCount, 1);
  await assert.rejects(() => client.discardPending(), /Only rejected/);
  await client.sync();
  assert.equal(client.pendingCount, 0);
  assert.equal(f.server().todayTasks.length, 1);
  assert.equal(f.attempts[0].requestId, f.attempts[1].requestId);
  assert.equal(f.server().todayTasks[0].id, task.id);
  await client.stop();
});

test("persistent queue: an in-flight request does not block new local actions or overwrite them on acknowledgement", async () => {
  const f = fixture();
  const queue = f.make(); await queue.sync(); await queue.stop();
  const gate = deferred();
  const client = f.make(async (command) => { await gate.promise; return f.execute(command); });
  const task = await client.enqueue("create_task", args, "UTC");
  await client.enqueue("rename_task", { id: task.id, outcome: "While sending" }, "UTC");
  assert.equal(client.pendingCount, 2);
  assert.equal(client.snapshot().todayTasks[0].outcome, "While sending");
  gate.resolve();
  await client.sync();
  assert.equal(f.server().todayTasks[0].outcome, "While sending");
  assert.equal(client.pendingCount, 0);
  await client.stop();
});

test("persistent queue: multiple windows serialize sends without losing enqueues", async () => {
  const f = fixture();
  const seed = f.make(); await seed.sync(); await seed.stop();
  const first = f.make(); const second = f.make();
  await Promise.all([first.enqueue("create_task", args, "UTC"), second.enqueue("create_task", { ...args, outcome: "Second window" }, "UTC")]);
  await Promise.all([first.sync(), second.sync()]);
  assert.equal(f.server().todayTasks.length, 2);
  assert.equal(f.attempts.length, 2);
  await first.stop(); await second.stop();
});

test("persistent queue: definitive rejection blocks dependents, retains data, and permits explicit discard", async () => {
  const f = fixture();
  const seed = f.make(); await seed.sync(); await seed.stop();
  const queue = f.make(async () => { throw { code: "validation", message: "Another device changed this task" }; });
  const task = await queue.enqueue("create_task", args, "UTC");
  await queue.enqueue("rename_task", { id: task.id, outcome: "Dependent" }, "UTC");
  await queue.sync();
  assert.equal(queue.blocked, true);
  assert.equal(queue.pendingCount, 2);
  assert.match(queue.status, /Another device/);
  await assert.rejects(() => queue.enqueue("create_task", args, "UTC"), /Resolve/);
  await queue.discardPending();
  await queue.sync();
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.snapshot().todayTasks.length, 0);
  await queue.stop();
});

test("persistent queue: storage failure does not claim an action was saved or send it", async () => {
  const f = fixture();
  const queue = f.make(); await queue.sync();
  f.storage.setItem = () => { throw new Error("Disk full"); };
  await assert.rejects(() => queue.enqueue("create_task", args, "UTC"), /Disk full/);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.snapshot().todayTasks.length, 0);
  assert.equal(f.attempts.length, 0);
  await queue.stop();
});

test("persistent queue: an enqueue during a dashboard read retains its source snapshot", async () => {
  const f = fixture();
  const seed = f.make(); await seed.sync();
  const task = await seed.enqueue("create_task", args, "UTC"); await seed.sync(); await seed.stop();
  const gate = deferred();
  let reads = 0;
  const client = f.make(f.execute, "alice", async () => {
    if (++reads === 1) { await gate.promise; return { ...dashboard(), todayTasks: [] }; }
    return structuredClone(f.server());
  });
  const sending = client.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await client.enqueue("rename_task", { id: task.id, outcome: "Keep this task" }, "UTC");
  gate.resolve(); await sending; await client.sync();
  assert.equal(f.server().todayTasks[0].outcome, "Keep this task");
  await client.stop();
});

test("projection: dates advance offline while keeping a previous day's active timer", () => {
  let data = dashboard();
  const midnight = Date.parse(`${day}T00:00:00Z`) / 1000;
  const command = (action, at, extra = {}) => ({ requestId: "task", action, at, timezone: "UTC", args: { id: "task", ...extra } });
  data = project(data, command("create_task", midnight + 86300, args));
  data = project(data, command("start_task", midnight + 86300));
  data = project(data, command("complete_task", midnight + 86450));
  assert.equal(data.today, tomorrow);
  assert.equal(data.activeTask, null);
  assert.deepEqual(data.completions, [{ day: tomorrow, count: 1 }]);
  data = project(data, command("create_task", midnight + 86500, { ...args, day: tomorrow }));
  assert.equal(data.todayTasks.length, 1);
});

test("projection: offline timers use event times, exclude pauses, and update completion totals", () => {
  let data = dashboard();
  const midnight = Date.parse(`${day}T00:00:00Z`) / 1000;
  const command = (action, at, extra = {}) => ({ requestId: "task", action, at: midnight + at, timezone: "UTC", args: { id: "task", ...extra } });
  data = project(data, command("create_task", 100, args));
  data = project(data, command("start_task", 100));
  data = project(data, command("stop_timer", 160));
  assert.equal(data.activeTask.actualSeconds, 60);
  assert.equal(data.activeTask.startedAt, null);
  data = project(data, command("resume_task", 200));
  data = project(data, command("complete_task", 230));
  assert.equal(data.todayTasks[0].actualSeconds, 90);
  assert.equal(data.activeTask, null);
  assert.equal(data.canPlanTomorrow, true);
  assert.deepEqual(data.completions, [{ day, count: 1 }]);
});
