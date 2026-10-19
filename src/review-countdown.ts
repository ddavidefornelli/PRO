/** Use the server's timezone-aware instant; older servers supply a local calendar date. */
export function reviewCountdown(week: { nextUpdate: string; nextUpdateAt?: string }, now = Date.now()) {
  const target = week.nextUpdateAt ? new Date(week.nextUpdateAt) : new Date(`${week.nextUpdate}T16:00:00`);
  if (!Number.isFinite(target.getTime())) return null;
  // Calendar arithmetic keeps the weekly progress accurate across DST changes.
  const start = new Date(target);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  const seconds = Math.max(0, Math.ceil((target.getTime() - now) / 1000));
  return {
    target,
    due: seconds === 0,
    values: [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60],
    progress: Math.min(1, Math.max(0, (now - start.getTime()) / (target.getTime() - start.getTime()))),
  };
}
