import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMessage } from "../src/errors.ts";
import { LocalQueue, project, QUEUE_STORAGE_VERSION } from "../src/local-queue.ts";
import { isDayComplete, trackedSeconds } from "../src/planner.ts";
import { DAY_MS, formatDuration, localDay } from "../src/time.ts";
import { dashboard, persistence } from "./helpers/queue.mjs";

for (const [timezone, expected] of [
  ["UTC", "2026-01-01"], ["Pacific/Kiritimati", "2026-01-01"], ["Pacific/Pago_Pago", "2025-12-31"],
  ["Europe/Rome", "2026-01-01"], ["America/New_York", "2025-12-31"],
  ["Asia/Kathmandu", "2026-01-01"], ["Australia/Lord_Howe", "2026-01-01"],
]) {
  test(`day formatting keeps cached timezone boundaries: ${timezone}`, () => {
    const at = Date.parse("2026-01-01T00:15:00Z") / 1000;
    for (let i = 0; i < 3; i++) {
      assert.equal(localDay(at, timezone), expected);
      assert.equal(localDay(at, "UTC"), "2026-01-01");
    }
    assert.equal(localDay(at + DAY_MS / 1000, timezone), expected === "2025-12-31" ? "2026-01-01" : "2026-01-02");
  });
}

test("duration formatting preserves zero padding and hours beyond a day", () => {
  for (const [seconds, expected] of [[0, "00:00:00"], [1, "00:00:01"], [59, "00:00:59"],
    [60, "00:01:00"], [3599, "00:59:59"], [3600, "01:00:00"], [90061, "25:01:01"]]) {
    assert.equal(formatDuration(seconds), expected);
  }
});

test("only a nonempty, fully completed plan unlocks tomorrow", () => {
  assert.equal(isDayComplete([]), false);
  assert.equal(isDayComplete([{ status: "completed" }]), true);
  for (const status of ["planned", "active"]) {
    assert.equal(isDayComplete([{ status: "completed" }, { status }]), false);
  }
});

test("tracked time includes saved work, excludes pauses and clamps clock rollback", () => {
  assert.equal(trackedSeconds({ actualSeconds: 20, startedAt: null }, 1000), 20);
  assert.equal(trackedSeconds({ actualSeconds: 20, startedAt: 100 }, 160), 80);
  assert.equal(trackedSeconds({ actualSeconds: 20, startedAt: 100 }, 90), 20);
});

test("error messages retain authored values and context-specific unknown-error fallbacks", () => {
  assert.equal(errorMessage(new Error("Disk full")), "Disk full");
  assert.equal(errorMessage({ message: 42 }), "42");
  for (const value of [null, undefined, "untrusted raw exception", 42, {}]) {
    assert.equal(errorMessage(value, "Safe fallback"), "Safe fallback");
  }
});

test("public projection never mutates its source snapshot, command or acknowledgement", () => {
  const base = dashboard();
  const command = { requestId: "task", action: "create_task", timezone: "UTC", at: base.serverNow, revision: 0,
    args: { day: base.today, outcome: "Original", estimatedMinutes: 30 } };
  const original = structuredClone({ base, command });
  const created = project(base, command);
  assert.deepEqual({ base, command }, original);
  const acknowledgement = { ...created.todayTasks[0], outcome: "Acknowledged", serverRevision: 1,
    resources: [{ id: "resource", kind: "link", label: "Reference", target: "https://example.com" }] };
  const result = project(base, command, acknowledgement);
  result.todayTasks[0].resources[0].label = "Caller edit";
  assert.equal(acknowledgement.resources[0].label, "Reference");
  assert.equal(result.revision, 1);
  assert.deepEqual({ base, command }, original);
});

test("batched snapshot replay matches pure projections and cannot mutate durable state", () => {
  const { storage, lock } = persistence();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = dashboard();
  base.today = localDay(base.serverNow, timezone);
  base.tomorrow = localDay(base.serverNow + DAY_MS / 1000, timezone);
  const pending = [];
  const command = (action, args = { id: "task" }) => pending.push({
    requestId: pending.length ? `request-${pending.length}` : "task", action, args, timezone,
    at: base.serverNow, revision: pending.length,
  });
  command("create_task", { outcome: "Batch", day: base.today, estimatedMinutes: 30 });
  command("start_task");
  for (let i = 0; i < 50; i++) command("rename_task", { id: "task", outcome: `Edit ${i}` });
  command("add_task_link", { id: "task", label: "Reference", target: "https://example.com" });
  command("complete_task");
  const saved = JSON.stringify({ version: QUEUE_STORAGE_VERSION, base, savedAt: base.serverNow, pending, blocked: null });
  storage.setItem("batch", saved);
  const queue = new LocalQueue("batch", storage, lock,
    async () => { throw new Error("Snapshot must not send"); }, async () => base);
  const expected = pending.reduce((data, action) => project(data, action), base);
  const snapshot = queue.snapshot();
  assert.deepEqual({ ...snapshot, serverNow: 0 }, { ...expected, serverNow: 0 });
  snapshot.todayTasks[0].resources[0].label = "Unsaved edit";
  snapshot.completions[0].count = 999;
  const fresh = queue.snapshot();
  assert.equal(fresh.todayTasks[0].resources[0].label, "Reference");
  assert.equal(fresh.completions[0].count, 1);
  assert.equal(storage.getItem("batch"), saved);
});
