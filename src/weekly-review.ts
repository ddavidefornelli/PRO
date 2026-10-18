import { PlanningClient, type ReviewStop, type WeeklyOverview, type WeeklyReview } from "./api";

import { actionButton, element as node } from "./dom";
import { errorMessage } from "./errors";
import { completedTaskTimings, focusDuration } from "../shared/task-timing";

const reviewDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Independent loading/error state: a model request never locks planning or the focus timer. */
export class WeeklyReviewPanel {
  readonly element = node("section", undefined, "weekly-overview");
  private data: WeeklyOverview | null = null;
  private loading = false;
  private saving = false;
  private changeVersion = 0;
  private error = "";
  private preview: WeeklyReview | null = null;
  private previewMessage = "";
  private pollTimer: number | undefined;

  constructor(private readonly client: PlanningClient) {
    this.element.setAttribute("aria-labelledby", "weekly-review-title");
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.loading || this.saving) return;
    this.loading = true;
    const version = this.changeVersion;
    try {
      const next = await this.client.weeklyOverview();
      // A read started before a consent change must not overwrite the action's newer state.
      if (version !== this.changeVersion) return;
      const changed = JSON.stringify(next) !== JSON.stringify(this.data);
      this.data = next;
      if (changed || this.error) {
        this.error = "";
        this.render();
      }
    } catch {
      if (version === this.changeVersion) {
        this.error = "Could not load your weekly review. Tasks and timers still work normally.";
        this.render();
      }
    } finally {
      this.loading = false;
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    window.clearTimeout(this.pollTimer);
    if (this.data?.status === "pending" || this.data?.status === "running") {
      this.pollTimer = window.setTimeout(() => {
        if (this.element.isConnected) void this.refresh();
      }, 3000);
    }
  }

  private render(): void {
    const settingsOpen = this.element.querySelector<HTMLDetailsElement>(".weekly-settings")?.open;
    this.element.replaceChildren();
    this.element.setAttribute("aria-busy", String(this.saving));
    const heading = node("h2", "Weekly review");
    heading.id = "weekly-review-title";
    this.element.append(heading, node("p", "Your week at a glance. Spot recurring interruptions, compare task time, and choose what to change next.", "muted"));
    if (this.error) {
      const error = node("p", this.error, "error");
      error.setAttribute("role", "alert");
      this.element.append(error, this.button("Retry loading", () => this.refresh()));
    }
    const data = this.data;
    if (!data) {
      if (!this.error) this.element.append(node("p", "Loading weekly review…", "muted"));
      return;
    }
    const settings = node("details", undefined, "weekly-settings");
    settings.open = settingsOpen ?? (!data.settings.enabled || !data.available);
    settings.append(node("summary", data.settings.enabled ? "Review settings & privacy" : "AI settings & privacy"));
    settings.append(node("p", "Weekly AI is optional. Enabling it allows PRO to send task titles, dates, status, estimates, recorded task time, and your written stop reasons to OpenAI for a weekly reflection. Attached resources, their links/paths, and their file contents are excluded; sensitive text written directly in a title or reason is still sent. Task value is not scored.", "muted"));
    settings.append(node("p", `Model: ${data.model} · Hosted AI ${data.available ? "enabled" : "temporarily unavailable"}`, "muted"));
    settings.append(node("p", "Planner data, including resource paths, is stored in Supabase for your signed-in account. Enabling AI additionally allows the selected activity to be processed by OpenAI. Saved reviews and their source snapshots remain in your account until removed; provider and backup retention policies also apply.", "muted"));
    const toggle = this.button(data.settings.enabled ? "Disable weekly AI" : "Enable weekly AI reviews", () => this.setEnabled(!data.settings.enabled));
    toggle.disabled = this.saving;
    settings.append(toggle);
    settings.append(node("p", "Reviews cover the previous Monday–Sunday and refresh on Monday while PRO is open, or at the next launch. If several weeks were missed, only the latest complete week is reviewed. Disabling stops future requests; saved reviews remain in your account. A request already sent cannot be recalled.", "muted"));
    this.element.append(settings);

    const messages: Record<WeeklyOverview["status"], string> = {
      disabled: "Weekly AI is off. Enable it above to receive a weekly reflection.",
      unavailable: "Hosted weekly AI is temporarily unavailable. Your planner is unaffected.",
      pending: `Your review for ${this.range(data.week.start, data.week.end)} is queued.`,
      running: `Reviewing ${this.range(data.week.start, data.week.end)}… You can keep using PRO.`,
      failed: data.error ?? "The weekly review could not be generated. Your previous reviews are unchanged.",
      no_data: `No tasks or stops were recorded for ${this.range(data.week.start, data.week.end)}. No AI request was made.`,
      up_to_date: "Your latest weekly review is ready.",
    };
    const status = node("p", messages[data.status], data.status === "failed" ? "error" : "muted");
    status.setAttribute("role", "status");
    if (data.status === "failed" || data.status === "pending" || data.status === "running" || data.status === "unavailable" || data.status === "no_data") {
      this.element.append(status);
    } else {
      settings.append(status);
    }
    if (data.settings.enabled) {
      settings.append(node("p", `Next scheduled update: ${this.date(data.week.nextUpdate)}. ${data.developmentUnlimited ? "Development mode: no request cooldown or usage cap." : "Failed requests retry at most hourly; successful reviews are not regenerated."}`, "muted"));
    }
    if (data.status === "failed") {
      this.element.append(this.button("Retry weekly review", () => this.retry()));
    }
    const previewButton = this.button(this.saving ? "Creating review…" : "Review this week so far", () => this.createPreview());
    previewButton.disabled = this.saving || !data.settings.enabled || !data.available || data.status === "running";
    if (data.settings.enabled && data.available) this.element.append(previewButton);
    settings.append(node("p", `Create an on-demand review from Monday through today. ${data.developmentUnlimited ? "Development mode: unlimited previews, with no cooldown." : "Up to 3 attempts per UTC day, at least 10 minutes apart."} It does not replace your scheduled weekly report. Previews are shown here until you reload or sign out; they are not saved in review history.`, "muted"));
    if (this.previewMessage) {
      const message = node("p", this.previewMessage, "muted");
      message.setAttribute("role", "status");
      this.element.append(message);
    }
    if (this.preview) {
      const preview = node("section", undefined, "weekly-preview");
      preview.append(node("h3", "This week so far · On-demand preview"), this.report(this.preview));
      this.element.append(preview);
    }
    data.reviews.forEach((review, index) => {
      if (index === 0) this.element.append(this.report(review));
      else {
        const history = node("details", undefined, "weekly-history");
        history.append(node("summary", this.range(review.weekStart, review.weekEnd)), this.report(review));
        this.element.append(history);
      }
    });
  }

  private report(review: WeeklyReview): HTMLElement {
    const article = node("article", undefined, "weekly-report");
    article.append(node("h3", this.range(review.weekStart, review.weekEnd)));
    const completed = review.activity.tasks.filter((task) => task.completedOn !== null && task.completedOn >= review.weekStart && task.completedOn <= review.weekEnd).length;
    const stats = node("dl", undefined, "review-stats");
    for (const [label, value] of [["Tasks completed", completed], ["Stops logged", review.activity.totalStops], ["Stop patterns", review.analysis.mainReasons.length]] as const) {
      const stat = node("div");
      stat.append(node("dt", label), node("dd", String(value)));
      stats.append(stat);
    }
    article.append(stats);
    if (review.activity.omittedStops > 0) {
      article.append(node("p", `This review uses the most recent ${review.activity.stops.length} stop reasons; ${review.activity.omittedStops} earlier stops were omitted to limit the AI payload.`, "muted"));
    }
    article.append(node("p", review.analysis.summary, "weekly-summary"));
    article.append(node("h4", "Reduce distractions · Try next week"));
    article.append(node("p", "Suggested experiments, not rules. Keep necessary breaks; focus on interruptions you can control.", "muted"));
    const improvements = node("ol", undefined, "weekly-improvements");
    for (const improvement of review.analysis.improvements) improvements.append(node("li", improvement));
    article.append(improvements);
    article.append(node("h4", "Estimated vs actual task time"));
    article.append(node("p", "Whole-task recorded focus time for tasks completed this week, excluding paused breaks. Tasks may span weeks; these are not weekly work-time totals.", "muted"));
    const timings = completedTaskTimings(review.activity.tasks, review.weekStart, review.weekEnd);
    const names = new Map(review.activity.tasks.map((task) => [task.id, task.outcome]));
    const timingList = node("ul", undefined, "weekly-task-timing");
    const timeScale = Math.max(1, ...timings.flatMap((timing) => [timing.estimatedSeconds, timing.hasRecordedTime ? timing.actualSeconds : 0]));
    if (timings.length) article.append(node("p", "Blue = estimate · Green = recorded focus time · Shared scale across tasks", "muted review-legend"));
    for (const timing of timings) {
      const difference = timing.differenceSeconds === 0 ? "on estimate"
        : `${focusDuration(Math.abs(timing.differenceSeconds))} ${timing.differenceSeconds > 0 ? "over" : "under"} estimate`;
      const item = node("li");
      item.append(node("strong", names.get(timing.taskId) ?? "Task"));
      item.append(node("p", `${focusDuration(timing.estimatedSeconds)} estimated · ${timing.hasRecordedTime ? `${focusDuration(timing.actualSeconds)} actual focus time · ${difference}` : "No focus time recorded; comparison unavailable"}`, "muted"));
      item.append(this.bar(timing.estimatedSeconds, timeScale, "review-bar-estimate"));
      if (timing.hasRecordedTime) item.append(this.bar(timing.actualSeconds, timeScale, "review-bar-actual"));
      timingList.append(item);
    }
    if (timings.length) article.append(timingList);
    else article.append(node("p", "No completed tasks in this review week to compare.", "muted"));
    article.append(node("h4", "What interrupted your focus?"));
    article.append(node("p", "Patterns suggested by AI, ranked by supporting entries. A stop is not always a distraction. Counts use included stop reasons only; patterns may overlap.", "muted"));
    const taskNames = new Map(review.activity.tasks.map((task) => [task.id, task.outcome]));
    const stops = new Map(review.activity.stops.map((stop) => [stop.id, stop]));
    if (!review.analysis.mainReasons.length) {
      article.append(node("p", "No stop reasons were logged for this week, so there are no reasons to interpret.", "muted"));
    }
    const rankedReasons = review.analysis.mainReasons.map((reason) => ({
      ...reason, evidenceStopIds: [...new Set(reason.evidenceStopIds)].filter((id) => stops.has(id)),
    })).sort((a, b) => b.evidenceStopIds.length - a.evidenceStopIds.length);
    for (const reason of rankedReasons) {
      const group = node("div", undefined, "weekly-reason");
      const count = reason.evidenceStopIds.length;
      const caption = node("div", undefined, "review-reason-caption");
      caption.append(node("p", reason.reason), node("span", `${count} ${count === 1 ? "entry" : "entries"}`, "review-count"));
      group.append(caption, this.bar(count, Math.max(1, review.activity.stops.length), "review-bar-reason"));
      const evidence = node("details", undefined, "review-evidence");
      evidence.append(node("summary", `View ${reason.evidenceStopIds.length} supporting stop ${reason.evidenceStopIds.length === 1 ? "entry" : "entries"}`));
      const list = node("ul");
      for (const id of reason.evidenceStopIds) {
        const stop = stops.get(id);
        if (stop) list.append(this.stopEntry(stop, taskNames));
      }
      evidence.append(list);
      group.append(evidence);
      article.append(group);
    }
    const sources = node("details", undefined, "review-evidence review-sources");
    sources.append(node("summary", "Activity used for this review"));
    sources.append(node("p", "Tasks are context only. Status and recorded time are snapshots at review time, not a historical reconstruction or a weekly time total.", "muted"));
    const taskList = node("ul");
    for (const task of review.activity.tasks) {
      taskList.append(node("li", `${task.outcome} · planned ${this.date(task.plannedFor)} · ${task.status}${task.completedOn ? ` on ${this.date(task.completedOn)}` : ""} · ${task.estimatedMinutes} min estimated · ${focusDuration(task.actualSeconds)} total recorded focus time`));
    }
    sources.append(taskList);
    if (review.activity.stops.length) {
      sources.append(node("h4", "Logged stop reasons"));
      const stopList = node("ul");
      for (const stop of review.activity.stops) stopList.append(this.stopEntry(stop, taskNames));
      sources.append(stopList);
    }
    article.append(sources, node("p", `AI-generated · ${review.model} · ${new Date(review.generatedAt * 1000).toLocaleString()}. Interpretations may be wrong; nothing in your plan is changed automatically.`, "muted weekly-disclaimer"));
    return article;
  }

  /** Decorative bars supplement explicit text values; no color-only information. */
  private bar(value: number, maximum: number, className: string): HTMLElement {
    const track = node("div", undefined, "review-bar-track");
    track.setAttribute("aria-hidden", "true");
    const fill = node("span", undefined, className);
    fill.style.width = `${Math.min(100, Math.max(0, value / maximum * 100))}%`;
    track.append(fill);
    return track;
  }

  private stopEntry(stop: ReviewStop, taskNames: Map<string, string>): HTMLLIElement {
    const item = node("li");
    item.append(node("span", `${this.date(stop.stoppedOn)} · ${taskNames.get(stop.taskId) ?? "Task"}`, "muted"), node("p", stop.reason));
    return item;
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    if (this.saving) return;
    this.changeVersion++;
    this.saving = true;
    this.error = "";
    this.render();
    try {
      this.data = await this.client.setWeeklyAiEnabled(enabled);
      if (this.data.settings.enabled) {
        const settings = this.element.querySelector<HTMLDetailsElement>(".weekly-settings");
        if (settings) settings.open = false;
      }
    } catch {
      this.error = "Could not save AI settings. Please try again.";
    } finally {
      this.saving = false;
      this.render();
      this.schedulePoll();
    }
    if (enabled && !this.error && this.data?.settings.enabled) void this.retry();
  }

  private async createPreview(): Promise<void> {
    if (this.saving || !this.data?.settings.enabled || !this.data.available) return;
    this.changeVersion++;
    this.saving = true;
    this.error = "";
    this.previewMessage = "";
    this.render();
    try {
      const result = await this.client.previewReview();
      if (result.noData) this.previewMessage = "No activity recorded this week yet. No AI request was made.";
      else if (result.review) {
        this.preview = result.review;
        this.previewMessage = "Your on-demand review is ready.";
      } else throw new Error("The AI review could not be loaded. Please try later.");
    } catch (error) {
      this.error = errorMessage(error, "Could not create a review. Your planner and saved reviews are unchanged.");
    } finally {
      this.saving = false;
      this.render();
      this.schedulePoll();
    }
  }

  private async retry(): Promise<void> {
    if (this.saving) return;
    this.changeVersion++;
    this.saving = true;
    this.error = "";
    this.render();
    try {
      await this.client.retryWeeklyReview();
      this.data = await this.client.weeklyOverview();
    } catch (error) {
      this.error = errorMessage(error, "Could not generate the weekly review. Please try later.");
    } finally {
      this.saving = false;
      this.render();
      this.schedulePoll();
    }
  }

  private button(text: string, action: () => Promise<void>): HTMLButtonElement {
    return actionButton(text, action, this.saving);
  }

  private date(day: string): string {
    return reviewDate.format(new Date(`${day}T12:00:00Z`));
  }

  private range(start: string, end: string): string {
    return `${this.date(start)} – ${this.date(end)}`;
  }
}
