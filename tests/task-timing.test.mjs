import assert from "node:assert/strict";
import test from "node:test";
import { completedTaskTimings, focusDuration } from "../shared/task-timing.ts";
import { providerBody } from "../supabase/functions/weekly-review/provider.ts";

const task = { id: "a", status: "completed", completedOn: "2026-10-13", estimatedMinutes: 30, actualSeconds: 3300 };
const start = "2026-10-12", end = "2026-10-18";

test("compares whole-task recorded time only for completions within the review week", () => {
  const tasks = [task, { ...task, id: "unfinished", status: "active", completedOn: null },
    { ...task, id: "older", completedOn: "2026-10-11" },
    { ...task, id: "later", completedOn: "2026-10-19" },
    { ...task, id: "zero", actualSeconds: 0, completedOn: start },
    { ...task, id: "short", actualSeconds: 90, completedOn: end }];
  assert.deepEqual(completedTaskTimings(tasks, start, end), [
    { taskId: "a", estimatedSeconds: 1800, actualSeconds: 3300, differenceSeconds: 1500, hasRecordedTime: true },
    { taskId: "zero", estimatedSeconds: 1800, actualSeconds: 0, differenceSeconds: -1800, hasRecordedTime: false },
    { taskId: "short", estimatedSeconds: 1800, actualSeconds: 90, differenceSeconds: -1710, hasRecordedTime: true },
  ]);
  assert.equal(completedTaskTimings([{ ...task, actualSeconds: 1800 }], start, end)[0].differenceSeconds, 0);
});

test("focus durations preserve seconds and support tasks longer than an hour", () => {
  for (const [seconds, text] of [[0, "0s"], [1, "1s"], [60, "1m"], [90, "1m 30s"], [3600, "1h"], [7261, "2h 1m 1s"]]) {
    assert.equal(focusDuration(seconds), text);
  }
});

test("provider receives server-calculated timing evidence without changing stored activity", () => {
  const input = { weekStart: start, weekEnd: end, activity: { tasks: [task], stops: [], totalStops: 0, omittedStops: 0 } };
  const source = JSON.parse(providerBody(input).messages[1].content);
  assert.deepEqual(source.activity, input.activity);
  assert.deepEqual(source.completedTaskTimings, completedTaskTimings([task], start, end));
  assert.match(providerBody(input).messages[0].content, /Zero recorded time means insufficient timing evidence/);
});
