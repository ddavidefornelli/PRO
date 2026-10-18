import { invoke } from "@tauri-apps/api/core";
import { LocalQueue, QUEUE_STORAGE_VERSION } from "./local-queue";

export interface TaskResource {
  id: string;
  label: string;
  target: string;
  kind: "link" | "file";
}

export interface Task {
  /** Mutation-response metadata; omitted from dashboard task rows. */
  serverRevision?: number;
  id: string;
  outcome: string;
  isPriority: boolean;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: "planned" | "active" | "completed";
  startedAt: number | null;
  completedOn: string | null;
  createdAt: number;
  resources: TaskResource[];
}

export interface Dashboard {
  revision?: number;
  today: string;
  tomorrow: string;
  todayTasks: Task[];
  tomorrowTasks: Task[];
  activeTask: Task | null;
  canPlanTomorrow: boolean;
  completions: { day: string; count: number }[];
  serverNow: number;
}

export interface ReviewStop {
  id: number;
  taskId: string;
  reason: string;
  stoppedOn: string;
}

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  generatedAt: number;
  model: string;
  activity: {
    tasks: Pick<Task, "id" | "outcome" | "plannedFor" | "completedOn" | "status" | "estimatedMinutes" | "actualSeconds">[];
    stops: ReviewStop[];
    totalStops: number;
    omittedStops: number;
  };
  analysis: {
    summary: string;
    mainReasons: { reason: string; evidenceStopIds: number[] }[];
    improvements: string[];
  };
}

export interface WeeklyOverview {
  settings: { enabled: boolean };
  model: string;
  available: boolean;
  week: { start: string; end: string; nextUpdate: string };
  status: "disabled" | "unavailable" | "pending" | "running" | "failed" | "no_data" | "up_to_date";
  error: string | null;
  reviews: WeeklyReview[];
}

export interface AuthStatus { configured: boolean; email: string | null; accountKey: string | null }

/** Tokens stay in Rust/OS credentials. The webview only receives the email and planner data. */
export class PlanningClient {
  private readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private queue: LocalQueue | null = null;
  private accountKey: string | null = null;
  private queueReady: Promise<void> | null = null;
  onQueueChange: () => void = () => {};
  get pendingCount(): number { return this.queue?.pendingCount ?? 0; }
  get syncBlocked(): boolean { return this.queue?.blocked ?? false; }
  cachedDashboard(): Dashboard | null { return this.queue?.snapshot() ?? null; }
  sync(): Promise<void> { return this.queue?.sync() ?? Promise.resolve(); }
  discardPending(): Promise<void> { return this.queue?.discardPending() ?? Promise.resolve(); }

  private prepareQueue(accountKey: string): void {
    if (this.queue) return;
    if (!navigator.locks) throw new Error("This desktop runtime does not support safe local queue locking. Update the system WebView.");
    this.accountKey = accountKey;
    this.queue = new LocalQueue(`pro:planner:v${QUEUE_STORAGE_VERSION}:${accountKey}`, localStorage,
      async (name, work) => await navigator.locks.request(name, work),
      async (command) => {
        // Never send retryable writes to an old server that ignores idempotency keys.
        if (!this.queueReady) this.queueReady = this.native<{ version: number }>("planner_call", {
          action: "queue_protocol", args: {}, timezone: this.timezone,
        }).then((protocol) => {
          if (protocol?.version !== 1) throw {
            code: "configuration",
            message: "The server does not support this queue version. Apply Supabase migration 20261017000300_local_queue.sql and update the desktop app if needed. Your changes remain on this device; no queued writes were sent.",
          };
        }).catch((error: unknown) => {
          this.queueReady = null;
          if (typeof error === "object" && error !== null && "code" in error && error.code === "validation") {
            // Older planner/native dispatchers reject queue_protocol. Keep this
            // retryable: no mutation has been sent and the outbox must not block.
            throw {
              code: "configuration",
              message: "The server or desktop runtime does not support queued sync. Apply Supabase migration 20261017000300_local_queue.sql and use the current desktop build. Your changes remain on this device; no queued writes were sent.",
            };
          }
          // Native errors are already sanitized. Preserve network/auth/server
          // failures rather than incorrectly diagnosing a missing migration.
          throw error;
        });
        await this.queueReady;
        return this.native<Task>("planner_call", {
          action: command.action, timezone: command.timezone,
          args: { ...command.args, _requestId: command.requestId, _at: command.at, _revision: command.revision, _accountKey: accountKey },
        });
      },
      () => this.native<Dashboard>("planner_call", { action: "dashboard", args: { _accountKey: accountKey }, timezone: this.timezone }));
    this.queue.onChange = () => this.onQueueChange();
    window.addEventListener("online", () => { void this.sync(); });
    window.addEventListener("storage", () => { void this.sync(); });
  }

  private async native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    try { return await invoke<T>(command, args); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && ["unauthorized", "account_changed"].includes(String(error.code))) {
        // Invalid credentials or another window's account switch must clear old UI state.
        window.location.reload();
      }
      throw error;
    }
  }
  private call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!["dashboard", "weekly_overview", "set_weekly_ai_enabled"].includes(action)) {
      if (!this.queue) return Promise.reject(new Error("Sign in and load your planner before making changes."));
      return this.queue.enqueue(action, args, this.timezone) as Promise<T>;
    }
    return this.native("planner_call", { action, args: { ...args, ...(this.accountKey ? { _accountKey: this.accountKey } : {}) }, timezone: this.timezone });
  }
  async authStatus(): Promise<AuthStatus> {
    const status = await this.native<AuthStatus>("auth_status");
    if (status.accountKey) this.prepareQueue(status.accountKey);
    return status;
  }
  requestSignInCode(email: string): Promise<void> { return this.native("request_sign_in_code", { email }); }
  verifySignInCode(email: string, code: string): Promise<AuthStatus> { return this.native("verify_sign_in_code", { email, code }); }
  async signOut(): Promise<void> {
    await this.queue?.stop();
    try { await this.native("sign_out"); }
    catch (error) { this.queue?.resume(); throw error; }
  }
  async generateIfDue(): Promise<void> {
    const overview = await this.weeklyOverview();
    if (overview.settings.enabled && overview.available && ["pending", "failed"].includes(overview.status)) {
      await this.retryWeeklyReview();
    }
  }
  async dashboard(): Promise<Dashboard> {
    if (!this.queue) return this.call("dashboard");
    let cached = this.queue.snapshot();
    if (!cached) { await this.queue.sync(); cached = this.queue.snapshot(); }
    else void this.queue.sync();
    if (!cached) throw new Error(this.queue.status);
    return cached;
  }

  weeklyOverview(): Promise<WeeklyOverview> {
    return this.call("weekly_overview");
  }

  setWeeklyAiEnabled(enabled: boolean): Promise<WeeklyOverview> {
    return this.call("set_weekly_ai_enabled", { enabled, consentVersion: "weekly-ai-v1" });
  }

  retryWeeklyReview(): Promise<void> {
    return this.native("generate_weekly_review", { timezone: this.timezone });
  }

  async previewReview(): Promise<{ review?: WeeklyReview; noData?: boolean }> {
    await this.sync();
    if (this.pendingCount) throw new Error("Sync pending planner changes before creating an AI review.");
    return this.native("generate_weekly_review", { timezone: this.timezone, preview: true });
  }

  create(outcome: string, day: string, estimatedMinutes: number): Promise<Task> {
    return this.call("create_task", { outcome, day, estimatedMinutes });
  }

  rename(id: string, outcome: string): Promise<Task> {
    return this.call("rename_task", { id, outcome });
  }

  changeEstimate(id: string, minutes: number): Promise<Task> {
    return this.call("change_estimate", { id, minutes });
  }

  addLink(id: string, label: string, url: string): Promise<Task> {
    return this.call("add_task_link", { id, label, target: url });
  }

  async attachFile(id: string): Promise<void> {
    if (this.pendingCount) throw new Error("Sync pending changes before attaching a file. File operations require a connection.");
    await this.native("attach_task_file", { id, timezone: this.timezone });
    await this.sync();
  }

  removeResource(id: string, resourceId: string): Promise<Task> {
    return this.call("remove_task_resource", { id, resourceId });
  }

  openResource(id: string, resourceId: string): Promise<void> {
    if (this.pendingCount) return Promise.reject(new Error("Sync pending changes before opening a resource."));
    return this.native("open_task_resource", { id, resourceId, timezone: this.timezone });
  }

  prioritize(id: string): Promise<Task> {
    return this.call("prioritize_task", { id });
  }

  start(id: string): Promise<Task> {
    return this.call("start_task", { id });
  }

  stopTimer(id: string): Promise<Task> {
    return this.call("stop_timer", { id });
  }

  savePauseReason(id: string, reason: string): Promise<void> {
    return this.call("save_pause_reason", { id, reason });
  }

  resume(id: string): Promise<Task> {
    return this.call("resume_task", { id });
  }

  complete(id: string): Promise<Task> {
    return this.call("complete_task", { id });
  }
}
