import { PlanningClient, type ReviewStop, type WeeklyOverview, type WeeklyReview } from "./api";

import { actionButton, element as node } from "./dom";
import { reviewCountdown } from "./review-countdown";
import { averageTaskTiming, focusDuration } from "../shared/task-timing";

/** Hide internal citations in saved reports too; structured evidence remains available. */
const reviewText = (text: string): string => text.replace(/\s*\(stop\s+ids?\s*:\s*\d+(?:\s*,\s*\d+)*\s*\)/gi, "");

const reviewDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Independent loading/error state: a model request never locks planning or the focus timer. */
export class WeeklyReviewPanel {
  readonly element = node("section", undefined, "weekly-overview");
  readonly settingsElement = node("section", undefined, "review-preferences");
  private data: WeeklyOverview | null = null;
  private loading = false;
  private saving = false;
  private changeVersion = 0;
  private error = "";

  private pollTimer: number | undefined;

  constructor(private readonly client: PlanningClient) {
    this.element.setAttribute("aria-labelledby", "weekly-review-title");
    this.render();
  }

  show(): HTMLElement {
    this.render();
    return this.element;
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
    const settingsOpen = this.settingsElement.querySelector<HTMLDetailsElement>(".weekly-settings")?.open;
    const settingsInProfile = this.settingsElement.isConnected && !this.element.contains(this.settingsElement);
    const showError = (target: HTMLElement): void => {
      const error = node("p", this.error, "error");
      error.setAttribute("role", "alert");
      target.append(error, this.button("Retry loading", () => this.refresh()));
    };
    this.element.replaceChildren();
    this.element.setAttribute("aria-busy", String(this.saving));
    const heading = node("h2", "Weekly review");
    heading.id = "weekly-review-title";
    this.element.append(heading);
    if (this.error && !settingsInProfile) showError(this.element);
    const data = this.data;
    if (!data) {
      if (settingsInProfile) {
        this.settingsElement.replaceChildren();
        if (this.error) showError(this.settingsElement);
        else this.settingsElement.append(node("p", "Loading AI settings…", "muted"));
      }
      if (!this.error) this.element.append(node("p", "Loading weekly review…", "muted"));
      return;
    }
    const settings = node("details", undefined, "weekly-settings");
    settings.open = settingsOpen ?? (!data.settings.enabled || !data.available);
    settings.append(node("summary", data.settings.enabled ? "Review settings & privacy" : "AI settings & privacy"));
    settings.append(node("p", "Weekly AI is optional. Enabling it allows prune to send task titles, dates, status, estimates, recorded task time, and your written stop reasons to OpenAI for a weekly reflection. Attached resources, their links/paths, and their file contents are excluded; sensitive text written directly in a title or reason is still sent. Task value is not scored.", "muted"));
    settings.append(node("p", `Model: ${data.model} · Hosted AI ${data.available ? "enabled" : "temporarily unavailable"}`, "muted"));
    settings.append(node("p", "Planner data, including resource paths, is stored in Supabase for your signed-in account. Enabling AI additionally allows the selected activity to be processed by OpenAI. Saved reviews and their source snapshots remain in your account until removed; provider and backup retention policies also apply.", "muted"));
    const toggle = this.button(data.settings.enabled ? "Disable weekly AI" : "Enable weekly AI reviews", () => this.setEnabled(!data.settings.enabled));
    toggle.disabled = this.saving;
    settings.append(toggle);
    settings.append(node("p", "Reviews appear Sunday at 4:00 p.m. in your local timezone while prune is open, or at the next launch. They cover Monday through the time of generation; later Sunday activity is not included. If several weeks were missed, only the latest due week is reviewed. Disabling stops future requests; saved reviews remain in your account. A request already sent cannot be recalled.", "muted"));
    this.settingsElement.replaceChildren(settings);
    if (this.error && settingsInProfile) showError(this.settingsElement);
    // Consent stays visible before opt-in; ongoing preferences live in Profile.
    if (!data.settings.enabled && !this.settingsElement.isConnected) this.element.append(this.settingsElement);

    const messages: Record<WeeklyOverview["status"], string> = {
      disabled: "Weekly AI is off. Enable it above to receive a weekly reflection.",
      unavailable: "Hosted weekly AI is temporarily unavailable. Your planner is unaffected.",
      pending: `Your review for ${this.range(data.week.start, data.week.end)} is queued.`,
      running: `Reviewing ${this.range(data.week.start, data.week.end)}… You can keep using prune.`,
      failed: `${data.error ?? "The weekly review could not be generated."} We’ll retry automatically. Your previous reviews are unchanged.`,
      no_data: `No tasks or stops were recorded for ${this.range(data.week.start, data.week.end)}. No AI request was made.`,
      up_to_date: "Your latest weekly review is ready.",
    };
    const status = node("p", messages[data.status], data.status === "failed" ? "error" : "muted");
    status.setAttribute("role", "status");
    if (data.status === "failed" || data.status === "pending" || data.status === "running" || data.status === "unavailable") {
      this.element.append(status);
    } else {
      settings.append(status);
    }
    if (data.settings.enabled) {
      settings.append(node("p", `Next scheduled update: ${this.date(data.week.nextUpdate)} at 4:00 p.m. local time. ${data.developmentUnlimited ? "Development mode: no request cooldown or usage cap." : "Failed requests retry at most hourly; successful reviews are not regenerated."}`, "muted"));
    }
    if (data.settings.enabled) this.element.append(this.countdown());
    data.reviews.forEach((review, index) => {
      if (index === 0) this.element.append(this.report(review));
      else {
        const history = node("details", undefined, "weekly-history");
        history.append(node("summary", `Previous review ${index}`), this.report(review));
        this.element.append(history);
      }
    });
  }

  private report(review: WeeklyReview): HTMLElement {
    const article = node("article", undefined, "weekly-report");
    const completed = review.activity.tasks.filter((task) => task.completedOn !== null && task.completedOn >= review.weekStart && task.completedOn <= review.weekEnd).length;
    const stats = node("dl", undefined, "review-stats");
    for (const [label, value] of [["Tasks completed", completed], ["Stops logged", review.activity.totalStops], ["Stop patterns", review.analysis.mainReasons.length]] as const) {
      const stat = node("div");
      stat.append(node("dt", label), node("dd", String(value)));
      stats.append(stat);
    }
    article.append(node("h4", "What to improve on this week"));
    const improvements = node("ol", undefined, "weekly-improvements");
    for (const improvement of review.analysis.improvements) improvements.append(node("li", reviewText(improvement)));
    article.append(improvements);
    article.append(node("h4", "Estimated vs actual task time"));
    const timing = averageTaskTiming(review.activity.tasks, review.weekStart, review.weekEnd);
    if (timing) {
      const comparison = node("div", undefined, `weekly-task-timing review-timing-comparison is-${timing.severity}`);
      const difference = timing.differenceSeconds === 0 ? "On estimate"
        : `${focusDuration(Math.abs(timing.differenceSeconds))} ${timing.differenceSeconds > 0 ? "over" : "under"} estimate`;
      const header = node("div", undefined, "review-timing-header");
      header.append(node("span", `Average per task · ${timing.count} completed ${timing.count === 1 ? "task" : "tasks"}`, "muted"));
      header.append(node("span", `${timing.severity === "green" ? "Within margin" : "Outside margin"} · ${difference}`, "review-timing-delta"));
      comparison.append(header);
      const timeScale = Math.max(timing.estimatedSeconds, timing.actualSeconds, 1);
      for (const [label, seconds, className] of [
        ["Average estimate", timing.estimatedSeconds, "review-bar-estimate"],
        ["Average actual", timing.actualSeconds, "review-bar-actual"],
      ] as const) {
        const row = node("div", undefined, "review-timing-row");
        const caption = node("div", undefined, "review-timing-caption");
        caption.append(node("span", label, "review-timing-label"), node("span", focusDuration(seconds), "review-timing-value"));
        row.append(caption, this.bar(seconds, timeScale, className));
        comparison.append(row);
      }
      if (timing.omittedCount) {
        comparison.append(node("p", `${timing.omittedCount} completed ${timing.omittedCount === 1 ? "task excluded" : "tasks excluded"} without recorded time.`, "muted review-legend"));
      }
      article.append(comparison);
    } else article.append(node("p", "Not enough recorded time for completed tasks to compare averages yet.", "muted"));
    article.append(node("h4", "Comprehensive review"));
    article.append(stats);
    if (review.activity.omittedStops > 0) {
      article.append(node("p", `${review.activity.stops.length} stop entries analyzed · ${review.activity.omittedStops} earlier stops were omitted.`, "muted"));
    }
    if (review.analysis.mainReasons.length) article.append(node("p", "Stop patterns · AI-grouped, may overlap", "muted"));
    const taskNames = new Map(review.activity.tasks.map((task) => [task.id, task.outcome]));
    const stops = new Map(review.activity.stops.map((stop) => [stop.id, stop]));
    if (!review.analysis.mainReasons.length) {
      article.append(node("p", "No stop patterns to analyze yet.", "muted"));
    }
    const rankedReasons = review.analysis.mainReasons.map((reason) => ({
      ...reason, evidenceStopIds: [...new Set(reason.evidenceStopIds)].filter((id) => stops.has(id)),
    })).sort((a, b) => b.evidenceStopIds.length - a.evidenceStopIds.length);
    for (const reason of rankedReasons) {
      const group = node("div", undefined, "weekly-reason");
      const count = reason.evidenceStopIds.length;
      const caption = node("div", undefined, "review-reason-caption");
      caption.append(node("p", reviewText(reason.reason)), node("span", `${count} ${count === 1 ? "entry" : "entries"}`, "review-count"));
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
    item.append(node("span", taskNames.get(stop.taskId) ?? "Task", "muted"), node("p", stop.reason));
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
        const settings = this.settingsElement.querySelector<HTMLDetailsElement>(".weekly-settings");
        if (settings) settings.open = false;
      }
    } catch {
      this.error = "Could not save AI settings. Please try again.";
    } finally {
      this.saving = false;
      this.render();
      this.schedulePoll();
    }
    if (enabled && !this.error && this.data?.settings.enabled) {
      // Opt-in may catch up a due review, but never creates an early preview.
      await this.client.generateIfDue().catch(() => { /* Automatic retries handle transient failures. */ });
      await this.refresh();
    }
  }

  private countdown(): HTMLElement {
    const card = node("section", undefined, "review-countdown");
    const preparing = this.data?.status === "pending" || this.data?.status === "running";
    card.classList.toggle("is-preparing", preparing);
    card.append(node("h3", preparing ? "Preparing your review…" : "Next review", "review-countdown-title"));
    if (!preparing) {
      const clock = node("div", undefined, "review-countdown-clock");
      clock.setAttribute("role", "timer");
      clock.setAttribute("aria-live", "off");
      for (const label of ["Days", "Hours", "Minutes", "Seconds"]) {
        const unit = node("div", undefined, "review-countdown-unit");
        unit.append(node("span", "00", "review-countdown-value"), node("span", label, "review-countdown-label"));
        clock.append(unit);
      }
      const track = node("div", undefined, "review-countdown-track");
      track.setAttribute("aria-hidden", "true");
      track.append(node("span"));
      card.append(clock, track, node("p", "", "review-countdown-date"));
    }
    // The card must be attached before tick queries its stable numeric nodes.
    queueMicrotask(() => this.tick());
    return card;
  }

  /** Update only clock text, never replace focused controls or announce every second. */
  tick(now = Date.now()): void {
    if (!this.element.isConnected || !this.data?.settings.enabled) return;
    const countdown = reviewCountdown(this.data.week, now);
    const clock = this.element.querySelector<HTMLElement>(".review-countdown-clock");
    if (!countdown || !clock) return;
    clock.querySelectorAll(".review-countdown-value").forEach((value, index) => {
      value.textContent = String(countdown.values[index]).padStart(2, "0");
    });
    clock.setAttribute("aria-label", `${countdown.values[0]} days, ${countdown.values[1]} hours, ${countdown.values[2]} minutes, ${countdown.values[3]} seconds until your next weekly review`);
    const fill = this.element.querySelector<HTMLElement>(".review-countdown-track > span");
    if (fill) fill.style.width = `${countdown.progress * 100}%`;
    const date = this.element.querySelector(".review-countdown-date");
    if (date) {
      date.textContent = countdown.due ? "Checking for your review…" : "";
      date.toggleAttribute("hidden", !countdown.due);
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
