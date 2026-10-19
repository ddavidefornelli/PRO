import type { Dashboard, Task } from "./api.ts";
import { errorMessage } from "./errors.ts";
import { trackedSeconds } from "./planner.ts";
import { DAY_MS, localDay } from "./time.ts";

export const QUEUE_STORAGE_VERSION = 1;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

export interface QueuedAction {
  requestId: string;
  action: string;
  args: Record<string, unknown>;
  timezone: string;
  at: number;
  revision: number;
}
interface SavedState {
  version: typeof QUEUE_STORAGE_VERSION;
  base: Dashboard | null;
  savedAt: number;
  pending: QueuedAction[];
  blocked: string | null;
}
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type Lock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
const empty = (): SavedState => ({ version: QUEUE_STORAGE_VERSION, base: null, savedAt: 0, pending: [], blocked: null });
const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown): string => errorMessage(error, "Could not sync. Your changes remain on this device.");
function alignDate(data: Dashboard, at: number, timezone: string): Dashboard {
  const today = localDay(at, timezone);
  if (today === data.today) return data;
  const tasks = [...data.todayTasks, ...data.tomorrowTasks];
  data.today = today;
  data.tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  data.todayTasks = tasks.filter((task) => task.plannedFor === data.today);
  data.tomorrowTasks = tasks.filter((task) => task.plannedFor === data.tomorrow);
  data.canPlanTomorrow = true;
  return data;
}

/** Mutates an owned snapshot; public callers clone once before replaying commands. */
function applyCommand(data: Dashboard, command: QueuedAction, result?: Task): Task {
  const { action, args, at } = command;
  alignDate(data, at, command.timezone);
  const tasks = [...data.todayTasks, ...data.tomorrowTasks];
  if (data.activeTask && !tasks.some((task) => task.id === data.activeTask!.id)) tasks.push(data.activeTask);
  let task = tasks.find((item) => item.id === args.id);
  if (action === "create_task") {
    task = { id: command.requestId, outcome: String(args.outcome).trim(), plannedFor: String(args.day),
      estimatedMinutes: Number(args.estimatedMinutes), isPriority: !tasks.some((item) => item.plannedFor === args.day),
      actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: at, resources: [] };
    tasks.push(task);
  }
  if (!task) throw new Error("This task is not available in the local planner. Sync before changing it.");
  const stop = () => {
    task!.actualSeconds = trackedSeconds(task!, at);
    task!.startedAt = null;
  };
  switch (action) {
    case "rename_task": task.outcome = String(args.outcome).trim(); break;
    case "change_estimate": task.estimatedMinutes = Number(args.minutes); break;
    case "prioritize_task":
      for (const item of tasks) if (item.plannedFor === task.plannedFor) item.isPriority = item.id === task.id;
      break;
    case "start_task": task.status = "active"; task.startedAt = at; break;
    case "resume_task": task.startedAt = at; break;
    case "pause_task": case "stop_timer": stop(); break;
    case "complete_task": {
      const wasCompleted = task.status === "completed";
      stop(); task.status = "completed";
      task.completedOn = localDay(at, command.timezone);
      if (!wasCompleted) {
        const completion = data.completions.find((item) => item.day === task!.completedOn);
        if (completion) completion.count++; else data.completions.push({ day: task.completedOn, count: 1 });
      }
      break;
    }
    case "add_task_link": task.resources.push({ id: command.requestId, kind: "link", label: String(args.label).trim(), target: String(args.target).trim() }); break;
    case "remove_task_resource": task.resources = task.resources.filter((item) => item.id !== args.resourceId); break;
  }
  data.revision = (data.revision ?? 0) + 1;
  if (result) {
    const { serverRevision, ...savedTask } = copy(result);
    Object.assign(task, savedTask);
    data.revision = serverRevision ?? data.revision;
  }
  data.todayTasks = tasks.filter((item) => item.plannedFor === data.today);
  data.tomorrowTasks = tasks.filter((item) => item.plannedFor === data.tomorrow);
  data.activeTask = tasks.find((item) => item.status === "active") ?? null;
  data.canPlanTomorrow = true;
  return task;
}

/** Pure projection, used both for immediate UI and crash recovery. Server validation remains authoritative. */
export function project(base: Dashboard, command: QueuedAction, result?: Task): Dashboard {
  const data = copy(base);
  applyCommand(data, command, result);
  return data;
}

function validateAcknowledgement(command: QueuedAction, task: Task): void {
  const expectedId = command.action === "create_task" ? command.requestId : command.args.id;
  if (!task || typeof task !== "object" || task.id !== expectedId
    || typeof task.outcome !== "string" || typeof task.plannedFor !== "string"
    || typeof task.isPriority !== "boolean" || !Number.isSafeInteger(task.estimatedMinutes)
    || !Number.isSafeInteger(task.actualSeconds) || task.actualSeconds < 0
    || !Number.isSafeInteger(task.createdAt) || !["planned", "active", "completed"].includes(task.status)
    || !(task.startedAt === null || Number.isSafeInteger(task.startedAt))
    || !(task.completedOn === null || typeof task.completedOn === "string")
    || !Array.isArray(task.resources) || task.resources.some((resource) => !resource
      || typeof resource.id !== "string" || typeof resource.label !== "string" || typeof resource.target !== "string"
      || !["file", "link"].includes(resource.kind))
    || (task.serverRevision !== undefined && task.serverRevision !== command.revision + 1)) {
    // A successful HTTP status alone is not an acknowledgement. Keep the same
    // request identity so an ambiguous/broken response can be retried safely.
    throw new Error("The server returned an incomplete acknowledgement. Your changes remain on this device; retry syncing.");
  }
}

/** One atomic storage value contains the acknowledged snapshot AND its ordered outbox. No tokens. */
export class LocalQueue {
  private state: SavedState = empty();
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_MS;
  private stopped = false;
  private lastError = "";
  onChange: () => void = () => {};
  private readonly key: string;
  private readonly storage: QueueStorage;
  private readonly lock: Lock;
  private readonly send: (command: QueuedAction) => Promise<Task>;
  private readonly fetchDashboard: () => Promise<Dashboard>;
  constructor(key: string, storage: QueueStorage, lock: Lock,
    send: (command: QueuedAction) => Promise<Task>, fetchDashboard: () => Promise<Dashboard>) {
    this.key = key; this.storage = storage; this.lock = lock;
    this.send = send; this.fetchDashboard = fetchDashboard;
    this.load();
  }

  private load(): void {
    const raw = this.storage.getItem(this.key);
    if (!raw) { this.state = empty(); return; }
    const saved = JSON.parse(raw) as SavedState;
    if (saved.version !== QUEUE_STORAGE_VERSION || !Array.isArray(saved.pending)) throw new Error("The local queue cannot be read. Do not clear app data; recover your pending changes first.");
    this.state = saved;
  }
  private async update(work: () => void): Promise<void> {
    await this.lock(`${this.key}:state`, async () => {
      this.load();
      const previous = copy(this.state);
      try {
        work();
        this.storage.setItem(this.key, JSON.stringify(this.state));
      } catch (error) { this.state = previous; throw error; }
    });
    this.onChange();
  }
  get pendingCount(): number { return this.state.pending.length; }
  get status(): string {
    if (this.state.blocked) return `Sync stopped: ${this.state.blocked} Pending changes are kept on this device.`;
    if (this.lastError) return `${this.lastError} ${this.pendingCount} change(s) waiting to sync.`;
    return this.pendingCount ? `${this.pendingCount} change(s) saved on this device · syncing…` : "All changes synced";
  }
  get blocked(): boolean { return !!this.state.blocked; }
  snapshot(): Dashboard | null {
    if (!this.state.base) return null;
    const data = copy(this.state.base);
    for (const command of this.state.pending) applyCommand(data, command);
    data.serverNow += Math.max(0, Date.now() / 1000 - this.state.savedAt);
    return alignDate(data, data.serverNow, Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  async enqueue(action: string, args: Record<string, unknown>, timezone: string): Promise<Task> {
    let result!: Task;
    await this.update(() => {
      if (this.stopped) throw new Error("The local queue is closed.");
      if (this.state.blocked) throw new Error("Resolve the sync conflict before making more changes.");
      const current = this.snapshot();
      if (!current) throw new Error("Connect once to load your planner before saving local changes.");
      const command: QueuedAction = { requestId: crypto.randomUUID(), action, args: copy(args), timezone, at: Math.floor(current.serverNow), revision: current.revision ?? 0 };
      // Completing an older active task removes it from the dashboard's day
      // lists. Return the mutated task itself, not a lookup in the filtered view.
      result = applyCommand(current, command);
      this.state.pending.push(command);
    });
    void this.sync();
    return copy(result);
  }
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.running = this.lock(`${this.key}:sender`, async () => {
      this.load();
      if (this.state.blocked || this.stopped) return;
      try {
        while (!this.stopped) {
          this.load();
          const command = this.state.pending[0];
          if (!command) break;
          const result = await this.send(command);
          validateAcknowledgement(command, result);
          await this.update(() => {
            if (this.state.pending[0]?.requestId !== command.requestId) throw new Error("Local queue changed during sync.");
            this.state.base = project(this.state.base!, command, result);
            this.state.pending.shift();
          });
        }
        if (this.stopped) return;
        const dashboard = await this.fetchDashboard();
        await this.update(() => {
          // An enqueue during this read may refer to a task from the previous day.
          // Keep its source snapshot until those actions have been acknowledged.
          if (!this.state.pending.length) { this.state.base = dashboard; this.state.savedAt = Date.now() / 1000; }
        });
        this.lastError = "";
        this.retryDelay = INITIAL_RETRY_MS;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
        if (code === "validation" && this.state.pending.length) {
          await this.update(() => { this.state.blocked = message(error); });
        } else {
          this.lastError = message(error);
          if (!this.stopped) {
            this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.sync(); }, this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
          }
        }
      }
    }).catch((error) => {
      this.lastError = message(error);
      if (!this.stopped && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.sync(); }, MAX_RETRY_MS);
    }).finally(() => {
      this.running = null;
      this.onChange();
      // An action can be enqueued during the final snapshot request.
      if (!this.stopped && !this.retryTimer && !this.state.blocked && this.state.pending.length) void this.sync();
    });
    return this.running;
  }
  async discardPending(): Promise<void> {
    // Never discard an ambiguously committed request. Only a definitive rejection allows discarding.
    if (!this.blocked) throw new Error("Only rejected changes can be discarded. Retry syncing first.");
    await this.lock(`${this.key}:sender`, () => this.update(() => {
      // Another window may have resolved the rejection and enqueued new work.
      // Authorize discarding against the freshly loaded state, under both locks.
      if (!this.state.blocked) throw new Error("Only rejected changes can be discarded. Retry syncing first.");
      this.state.pending = []; this.state.blocked = null;
    }));
    this.lastError = "";
    void this.sync();
  }
  resume(): void { this.stopped = false; void this.sync(); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.running;
  }
}
