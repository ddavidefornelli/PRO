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

/** Preserve seconds so short tasks are not displayed as zero minutes. */
export function focusDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder || seconds === 0 ? `${remainder}s` : ""]
    .filter(Boolean).join(" ");
}
