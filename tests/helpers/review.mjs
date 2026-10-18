export const NOW = new Date("2026-10-19T12:00:00Z");
export function reviewInput() {
  return {
    consentVersion: "weekly-ai-v1", weekStart: "2026-10-12", weekEnd: "2026-10-18",
    activity: {
      tasks: [{ id: "task-1", outcome: "Finish proposal", plannedFor: "2026-10-12", completedOn: "2026-10-13", status: "completed", estimatedMinutes: 30, actualSeconds: 1800 }],
      stops: [{ id: 1, taskId: "task-1", reason: "Lunch", stoppedOn: "2026-10-12" }], totalStops: 1, omittedStops: 0,
    },
  };
}
export function analysis() {
  return { summary: "One task was completed.", mainReasons: [{ reason: "A lunch break was recorded.", evidenceStopIds: [1] }], improvements: ["Continue recording reasons for stopping."] };
}
