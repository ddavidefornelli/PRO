type TimedTask = {
  id: string;
  status: string;
  completedOn: string | null;
  estimatedMinutes: number;
  actualSeconds: number;
};

/** Lifetime recorded focus time, not wall-clock duration or time worked in this week. */
export function completedTaskTimings(tasks: readonly TimedTask[], weekStart: string, weekEnd: string) {
  return tasks
    .filter((task) => task.status === "completed" && task.completedOn !== null
      && task.completedOn >= weekStart && task.completedOn <= weekEnd)
    .map((task) => ({
      taskId: task.id,
      estimatedSeconds: task.estimatedMinutes * 60,
      actualSeconds: task.actualSeconds,
      differenceSeconds: task.actualSeconds - task.estimatedMinutes * 60,
      hasRecordedTime: task.actualSeconds > 0,
    }));
}

/** Compare per-task averages for the same completed tasks with recorded time.
 * Color indicates estimate deviation in either direction, not task value.
 */
export function averageTaskTiming(tasks: readonly TimedTask[], weekStart: string, weekEnd: string) {
  const completed = completedTaskTimings(tasks, weekStart, weekEnd);
  const recorded = completed.filter((task) => task.hasRecordedTime);
  if (!recorded.length) return null;
  const estimated = recorded.reduce((sum, task) => sum + task.estimatedSeconds, 0) / recorded.length;
  const actual = recorded.reduce((sum, task) => sum + task.actualSeconds, 0) / recorded.length;
  const deviation = Math.abs(actual - estimated);
  const ratio = deviation / estimated;
  const severity = deviation <= Math.max(60, estimated * 0.1) ? "green"
    : ratio <= 0.25 ? "yellow" : ratio <= 0.5 ? "orange" : "red";
  const estimatedSeconds = Math.round(estimated);
  const actualSeconds = Math.round(actual);
  return {
    count: recorded.length,
    omittedCount: completed.length - recorded.length,
    estimatedSeconds,
    actualSeconds,
    differenceSeconds: actualSeconds - estimatedSeconds,
    severity,
  };
}

/** Preserve seconds so short tasks are not displayed as zero minutes. */
export function focusDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder || seconds === 0 ? `${remainder}s` : ""]
    .filter(Boolean).join(" ");
}
