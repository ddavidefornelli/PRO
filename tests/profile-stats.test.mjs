import assert from "node:assert/strict";
import test from "node:test";
import { profileStats } from "../src/profile-stats.ts";

function dashboard(today = "2026-10-17", completions = [], todayTasks = []) {
  return { today, tomorrow: "2026-10-18", todayTasks, tomorrowTasks: [], activeTask: null,
    canPlanTomorrow: false, completions, serverNow: 1000 };
}
const completions = (...days) => days.map((day) => ({ day, count: 1 }));

test("empty accounts have zero stats, not invented progress", () => {
  assert.deepEqual(profileStats(dashboard()), {
    totalCompleted: 0, activeDays: 0, currentStreak: 0, bestStreak: 0,
    todayCompleted: 0, weekCompleted: 0, monthCompleted: 0,
    todayFocusSeconds: 0, todayEstimatedMinutes: 0,
  });
});

test("totals cover all years; recent stats exclude future and zero-count dates", () => {
  const history = [
    { day: "2025-12-31", count: 3 }, { day: "2026-09-30", count: 2 },
    { day: "2026-10-11", count: 1 }, { day: "2026-10-12", count: 2 },
    { day: "2026-10-17", count: 3 }, { day: "2026-10-18", count: 3 },
    { day: "2026-10-16", count: 0 },
  ];
  const stats = profileStats(dashboard("2026-10-17", history));
  assert.equal(stats.totalCompleted, 11);
  assert.equal(stats.activeDays, 5);
  assert.equal(stats.todayCompleted, 3);
  assert.equal(stats.weekCompleted, 5);
  assert.equal(stats.monthCompleted, 6);
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.bestStreak, 2);
});

test("Monday begins a new week even across month/year boundaries", () => {
  const history = completions("2023-12-31", "2024-01-01", "2024-01-07", "2024-01-08");
  assert.equal(profileStats(dashboard("2024-01-07", history)).weekCompleted, 2);
  assert.equal(profileStats(dashboard("2024-01-08", history)).weekCompleted, 1);
  assert.equal(profileStats(dashboard("2024-01-01", history)).monthCompleted, 1);
});

test("streaks span year boundaries, leap days and DST without counting multiple tasks as days", () => {
  for (const days of [
    ["2025-12-30", "2025-12-31", "2026-01-01"],
    ["2024-02-28", "2024-02-29", "2024-03-01"],
    ["2026-03-07", "2026-03-08", "2026-03-09"],
    ["2026-10-31", "2026-11-01", "2026-11-02"],
  ]) {
    const stats = profileStats(dashboard(days.at(-1), days.map((day) => ({ day, count: 3 }))));
    assert.equal(stats.currentStreak, 3);
    assert.equal(stats.bestStreak, 3);
    assert.equal(stats.totalCompleted, 9);
  }
});

test("today can still be in progress, but a missed full day breaks the current streak", () => {
  const history = completions("2026-10-14", "2026-10-15", "2026-10-16");
  assert.equal(profileStats(dashboard("2026-10-17", history)).currentStreak, 3);
  const missed = profileStats(dashboard("2026-10-18", history));
  assert.equal(missed.currentStreak, 0);
  assert.equal(missed.bestStreak, 3);
});

test("focus uses saved time plus nonnegative running time on today's tasks only", () => {
  const data = dashboard("2026-10-17", [], [
    { actualSeconds: 120, startedAt: null, estimatedMinutes: 30 },
    { actualSeconds: 60, startedAt: 900, estimatedMinutes: 20 },
  ]);
  data.tomorrowTasks = [{ actualSeconds: 500, startedAt: null, estimatedMinutes: 60 }];
  assert.equal(profileStats(data).todayFocusSeconds, 280);
  assert.equal(profileStats(data, 1100).todayFocusSeconds, 380);
  assert.equal(profileStats(data, 800).todayFocusSeconds, 180);
  assert.equal(profileStats(data).todayEstimatedMinutes, 50);
});
