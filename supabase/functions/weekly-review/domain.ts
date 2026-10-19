export const CONSENT_VERSION = "weekly-ai-v1";
export const MAX_REQUEST_BYTES = 65_536;
const DAY_MS = 86_400_000;

type Task = {
  id: string;
  outcome: string;
  plannedFor: string;
  completedOn: string | null;
  status: "planned" | "active" | "completed";
  estimatedMinutes: number;
  actualSeconds: number;
};
type Stop = { id: number; taskId: string; reason: string; stoppedOn: string };
export type Activity = { tasks: Task[]; stops: Stop[]; totalStops: number; omittedStops: number };
export type ReviewInput = {
  consentVersion: typeof CONSENT_VERSION;
  weekStart: string;
  weekEnd: string;
  activity: Activity;
};
export type Analysis = {
  summary: string;
  mainReasons: { reason: string; evidenceStopIds: number[] }[];
  improvements: string[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(): never {
  throw new ApiError(400, "invalid_request", "The weekly activity is invalid or exceeds the review limits.");
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max || value.includes("\0")) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function previousMonday(day: Date): string {
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - (offset + 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Strict allowlist: resource paths/URLs, model choices and prompts are never accepted. */
export function validateInput(value: unknown, now: Date, preview = false): ReviewInput {
  const input = record(value, ["consentVersion", "weekStart", "weekEnd", "activity"]);
  if (input.consentVersion !== CONSENT_VERSION) {
    throw new ApiError(400, "consent_required", "Enable weekly AI using the current privacy notice before requesting a review.");
  }
  const weekStart = date(input.weekStart);
  const weekEnd = date(input.weekEnd);
  // Accept the latest due week in any real timezone, including Sunday 16:00.
  // The service-only SQL loader selects the exact local schedule boundary.
  const validWeeks = [-1, 0, 1].map((offset) => previousMonday(new Date(now.getTime() + offset * DAY_MS)));
  if (preview) {
    const localDays = [-1, 0, 1].map((offset) => new Date(now.getTime() + offset * DAY_MS).toISOString().slice(0, 10));
    const end = new Date(`${weekEnd}T00:00:00Z`);
    const monday = new Date(end.getTime() - ((end.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    if (!localDays.includes(weekEnd) || weekStart !== monday) invalid();
  } else if (!validWeeks.includes(weekStart) || Date.parse(weekEnd) - Date.parse(weekStart) !== 6 * DAY_MS) invalid();
  const activity = record(input.activity, ["tasks", "stops", "totalStops", "omittedStops"]);
  if (!Array.isArray(activity.tasks) || activity.tasks.length > 256 || !Array.isArray(activity.stops) || activity.stops.length > 200) invalid();
  const tasks: Task[] = activity.tasks.map((value) => {
    const task = record(value, ["id", "outcome", "plannedFor", "completedOn", "status", "estimatedMinutes", "actualSeconds"]);
    if (!["planned", "active", "completed"].includes(String(task.status))) invalid();
    const completedOn = task.completedOn === null ? null : date(task.completedOn);
    if ((task.status === "completed") !== (completedOn !== null)) invalid();
    return {
      id: text(task.id, 100), outcome: text(task.outcome, 500), plannedFor: date(task.plannedFor),
      completedOn, status: task.status as Task["status"],
      estimatedMinutes: integer(task.estimatedMinutes, 1, 60), actualSeconds: integer(task.actualSeconds, 0, 315_576_000),
    };
  });
  const taskIds = new Set(tasks.map(({ id }) => id));
  if (taskIds.size !== tasks.length) invalid();
  const stops: Stop[] = activity.stops.map((value) => {
    const stop = record(value, ["id", "taskId", "reason", "stoppedOn"]);
    const taskId = text(stop.taskId, 100);
    const stoppedOn = date(stop.stoppedOn);
    if (!taskIds.has(taskId) || stoppedOn < weekStart || stoppedOn > weekEnd) invalid();
    return { id: integer(stop.id, 1, Number.MAX_SAFE_INTEGER), taskId, reason: text(stop.reason, 1000), stoppedOn };
  });
  if (new Set(stops.map(({ id }) => id)).size !== stops.length) invalid();
  const totalStops = integer(activity.totalStops, 0, 1_000_000);
  const omittedStops = integer(activity.omittedStops, 0, 1_000_000);
  if (totalStops !== stops.length + omittedStops || (!tasks.length && !stops.length)) invalid();
  // Older tasks are allowed only as context for a stop or completion in this week.
  const stoppedTaskIds = new Set(stops.map(({ taskId }) => taskId));
  if (tasks.some((task) => !(task.plannedFor >= weekStart && task.plannedFor <= weekEnd)
    && !(task.completedOn && task.completedOn >= weekStart && task.completedOn <= weekEnd)
    && !stoppedTaskIds.has(task.id))) invalid();
  const textLength = tasks.reduce((sum, task) => sum + [...task.outcome].length, 0)
    + stops.reduce((sum, stop) => sum + [...stop.reason].length, 0);
  if (textLength > 16_000) invalid();
  return { consentVersion: CONSENT_VERSION, weekStart, weekEnd, activity: { tasks, stops, totalStops, omittedStops } };
}

/** Reconstruct fields rather than trusting structured output or provider-supplied evidence. */
export function validateAnalysis(value: unknown, activity: Activity): Analysis {
  try {
    const analysis = record(value, ["summary", "mainReasons", "improvements"]);
    if (!Array.isArray(analysis.mainReasons) || analysis.mainReasons.length > 6
      || (activity.stops.length > 0 && analysis.mainReasons.length === 0)
      || !Array.isArray(analysis.improvements) || analysis.improvements.length < 1 || analysis.improvements.length > 3) invalid();
    const ids = new Set(activity.stops.map(({ id }) => id));
    const mainReasons = analysis.mainReasons.map((value) => {
      const pattern = record(value, ["reason", "evidenceStopIds"]);
      if (!Array.isArray(pattern.evidenceStopIds) || pattern.evidenceStopIds.length < 1 || pattern.evidenceStopIds.length > 30) invalid();
      const evidenceStopIds = pattern.evidenceStopIds.map((id) => integer(id, 1, Number.MAX_SAFE_INTEGER));
      if (new Set(evidenceStopIds).size !== evidenceStopIds.length || evidenceStopIds.some((id) => !ids.has(id))) invalid();
      return { reason: text(pattern.reason, 1500), evidenceStopIds };
    });
    return { summary: text(analysis.summary, 3000), mainReasons, improvements: analysis.improvements.map((step) => text(step, 1000)) };
  } catch {
    throw new ApiError(502, "invalid_review", "The AI returned an incomplete or unsupported review. Please retry later.");
  }
}

export async function fingerprint(input: ReviewInput): Promise<string> {
  // Sort context collections so harmless order changes don't invalidate retry caching.
  const canonical = { ...input, activity: { ...input.activity,
    tasks: [...input.activity.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    stops: [...input.activity.stops].sort((a, b) => a.id - b.id),
  } };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
