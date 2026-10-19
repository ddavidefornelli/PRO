import assert from "node:assert/strict";
import test from "node:test";
import { averageTaskTiming, completedTaskTimings, focusDuration } from "../shared/task-timing.ts";
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

test("weekly averages use matching recorded tasks, not missing-time or unfinished tasks", () => {
  const result = averageTaskTiming([
    { ...task, actualSeconds: 1800 },
    { ...task, id: "b", estimatedMinutes: 60, actualSeconds: 4200 },
    { ...task, id: "missing", estimatedMinutes: 10, actualSeconds: 0 },
    { ...task, id: "unfinished", status: "active", completedOn: null },
    { ...task, id: "old", completedOn: "2026-10-11" },
  ], start, end);
  assert.deepEqual(result, { count: 2, omittedCount: 1, estimatedSeconds: 2700,
    actualSeconds: 3000, differenceSeconds: 300, severity: "yellow" });
  assert.equal(averageTaskTiming([], start, end), null);
  assert.equal(averageTaskTiming([{ ...task, actualSeconds: 0 }], start, end), null);
});

test("deviation colors are symmetric with inclusive tolerance and severity boundaries", () => {
  for (const direction of [-1, 1]) {
    for (const [difference, severity] of [[0, "green"], [180, "green"], [181, "yellow"],
      [450, "yellow"], [451, "orange"], [900, "orange"], [901, "red"]]) {
      const result = averageTaskTiming([{ ...task, actualSeconds: 1800 + direction * difference }], start, end);
      assert.equal(result.severity, severity, `${direction * difference} seconds`);
    }
  }
  assert.equal(averageTaskTiming([{ ...task, estimatedMinutes: 5, actualSeconds: 360 }], start, end).severity, "green");
  assert.equal(averageTaskTiming([{ ...task, estimatedMinutes: 5, actualSeconds: 239 }], start, end).severity, "yellow");
});

test("20 tasks produce one pair of per-task averages", () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ ...task, id: String(i), actualSeconds: 1800 + i * 60 }));
  const result = averageTaskTiming(tasks, start, end);
  assert.equal(result.count, 20);
  assert.equal(result.estimatedSeconds, 1800);
  assert.equal(result.actualSeconds, 2370);
  assert.equal(result.severity, "orange");
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
  assert.match(providerBody(input).messages[0].content, /no calendar dates/);
  assert.match(providerBody(input).messages[0].content, /at most 18 words/);
});
