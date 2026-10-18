import type { Dashboard } from "./api";

import { trackedSeconds } from "./planner.ts";
import { DAY_MS } from "./time.ts";
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** Calendar arithmetic uses date keys, not elapsed local hours (which vary across DST). */
export function profileStats(data: Dashboard, now = data.serverNow) {
  const today = dayNumber(data.today);
  const weekday = new Date(today * DAY_MS).getUTCDay();
  const weekStart = today - (weekday + 6) % 7; // Monday–Sunday, like weekly reviews.
  const monthStart = dayNumber(`${data.today.slice(0, 7)}-01`);
  const counts = new Map<number, number>();
  for (const { day, count } of data.completions) {
    const date = dayNumber(day);
    if (date <= today && count > 0) counts.set(date, (counts.get(date) ?? 0) + count);
  }
  const days = [...counts.keys()].sort((a, b) => a - b);
  let bestStreak = 0;
  let streak = 0;
  let previous = -Infinity;
  for (const day of days) {
    streak = day === previous + 1 ? streak + 1 : 1;
    bestStreak = Math.max(bestStreak, streak);
    previous = day;
  }
  // A streak remains current until an entire day passes without a completion.
  let currentStreak = 0;
  for (let day = counts.has(today) ? today : today - 1; counts.has(day); day--) currentStreak++;
  const completedSince = (start: number): number => days.reduce((sum, day) => sum + (day >= start ? counts.get(day)! : 0), 0);

  return {
    totalCompleted: completedSince(-Infinity),
    activeDays: days.length,
    currentStreak,
    bestStreak,
    todayCompleted: counts.get(today) ?? 0,
    weekCompleted: completedSince(weekStart),
    monthCompleted: completedSince(monthStart),
    // The dashboard does not contain historical focus totals. Keep this metric explicitly scoped.
    todayFocusSeconds: data.todayTasks.reduce((sum, task) => sum + trackedSeconds(task, now), 0),
    todayEstimatedMinutes: data.todayTasks.reduce((sum, task) => sum + task.estimatedMinutes, 0),
  };
}
