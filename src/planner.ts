import type { Task } from "./api.ts";

/** UI bounds mirror the independently enforced database constraints. */
export const PLANNER_LIMITS = {
  tasksPerDay: 3,
  outcomeLength: 500,
  stopReasonLength: 1000,
  resourceLabelLength: 200,
  resourceTargetLength: 8192,
} as const;

export function isDayComplete(tasks: readonly Task[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "completed");
}

/** Saved time plus the current running segment; pauses and clock rollback add nothing. */
export function trackedSeconds(task: Pick<Task, "actualSeconds" | "startedAt">, now: number): number {
  return task.actualSeconds + (task.startedAt === null ? 0 : Math.max(0, now - task.startedAt));
}
