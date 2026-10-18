import { PlanningClient, type Dashboard, type Task } from "./api";
import { estimateDial } from "./estimate-dial";
import { ActivityCalendar } from "./activity-calendar";
import { WeeklyReviewPanel } from "./weekly-review";
import { authenticate } from "./auth";
import { profileIcon, profilePage } from "./profile";
import { actionButton, decorativeSvg, element, svgElement } from "./dom";
import { errorMessage } from "./errors";
import { isDayComplete, PLANNER_LIMITS, trackedSeconds } from "./planner";
import { formatDuration } from "./time";
import { focusDuration } from "../shared/task-timing";
import "./styles.css";

type View = "today" | "focus" | "tomorrow" | "habits" | "profile";

const FOCUS_RING_RADIUS = 54;
const FOCUS_RING_CIRCUMFERENCE = 2 * Math.PI * FOCUS_RING_RADIUS;
const CONFETTI_COLORS = ["#30d158", "#0a84ff", "#ffd60a", "#ff375f", "#bf5af2"];
const PLANNER_BUTTONS = ".account-bar button, nav button, main button";

class PlanningApplication {
  private data: Dashboard | null = null;
  private dataSignature = "";
  private view: View = "today";
  private busy = false;
  private refreshing = false;
  private error = "";
  private clockOffset = 0;
  private pauseReasonOpen = false;
  // Scratchpad only: never included in storage, API calls, or the offline queue.
  private focusNotes = "";
  private focusNotesTaskId: string | null = null;
  private completionState: { day: string; complete: boolean } | null = null;

  private get todayComplete(): boolean {
    return isDayComplete(this.data?.todayTasks ?? []);
  }
  private readonly account = element("header", undefined, "account-bar");
  private readonly profileButton = this.button("Profile", () => {
    this.view = "profile";
    this.render();
  });
  private readonly navigation = element("nav");
  private readonly content = element("main");
  private readonly alert = element("p", "", "error");
  private readonly syncBar = element("div", undefined, "sync-bar");
  private readonly syncLabel = element("span");
  private readonly weeklyReview: WeeklyReviewPanel;
  private readonly activityCalendar = new ActivityCalendar();

  constructor(
    private readonly root: HTMLElement,
    private readonly client: PlanningClient,
    private readonly email: string,
  ) {
    this.weeklyReview = new WeeklyReviewPanel(client);
  }

  async mount(): Promise<void> {
    this.profileButton.className = "profile-button";
    this.profileButton.setAttribute("aria-label", "Profile");
    this.profileButton.setAttribute("aria-controls", "planner-content");
    this.profileButton.replaceChildren(profileIcon());
    this.account.append(this.profileButton);
    this.content.id = "planner-content";
    this.navigation.setAttribute("aria-label", "Main navigation");
    this.alert.setAttribute("role", "alert");
    this.syncLabel.setAttribute("role", "alert");
    const discard = this.button("Discard rejected changes", async () => {
      if (window.confirm("Discard ALL pending changes on this device, including changes depending on the rejected action? Synced changes will be kept.")) {
        await this.client.discardPending();
      }
    });
    const updateSyncStatus = () => {
      // Routine saves and connection retries stay invisible. Only a rejected
      // change needs a user decision; never silently discard pending work.
      this.syncBar.hidden = !this.client.syncBlocked;
      this.syncLabel.textContent = this.client.syncBlocked
        ? "Some recent changes could not be applied. They are kept on this device until you discard them."
        : "";
      const next = this.client.cachedDashboard();
      if (next && !this.refreshDeferred && this.applyDashboard(next)) this.render();
    };
    this.client.onQueueChange = updateSyncStatus;
    this.syncBar.append(this.syncLabel, discard);
    this.root.append(this.account, this.navigation, this.syncBar, this.alert, this.content);
    updateSyncStatus();
    new ResizeObserver(() => this.updateNavigationIndicator()).observe(this.navigation);
    await this.refresh(true);
    void this.client.generateIfDue().catch(() => { /* AI availability never blocks planning. */ });
    window.setInterval(() => {
      void this.client.generateIfDue().catch(() => { /* Server quotas enforce retry backoff. */ });
    }, 60_000);
    window.setInterval(() => this.tick(), 1000);
    // Refresh after sleep/date rollover without replacing an in-progress form.
    window.setInterval(() => {
      void this.refresh(false);
    }, 30_000);
    window.addEventListener("focus", () => {
      void this.refresh(false);
    });
  }

  private get refreshDeferred(): boolean {
    return this.busy || this.refreshing || this.pauseReasonOpen || !!this.content.querySelector("dialog[open]")
      || !!document.activeElement?.matches("input, textarea, [role=slider]");
  }

  private applyDashboard(next: Dashboard): boolean {
    const signature = JSON.stringify({ ...next, serverNow: 0 });
    const changed = signature !== this.dataSignature;
    this.dataSignature = signature;
    this.data = next;
    this.clockOffset = next.serverNow * 1000 - Date.now();
    return changed;
  }

  private async refresh(initial: boolean): Promise<void> {
    if (this.refreshDeferred) return;
    this.refreshing = true;
    try {
      const next = await this.client.dashboard();
      const changed = this.applyDashboard(next);
      if (initial && next.activeTask) this.view = "focus";
      if (changed || this.error) {
        this.error = "";
        this.render();
      }
    } catch (error) {
      this.error = this.message(error);
      this.render();
    } finally {
      this.refreshing = false;
      if (this.data && this.view === "habits") void this.weeklyReview.refresh();
    }
  }

  private render(): void {
    const activeTaskId = this.data?.activeTask?.id ?? null;
    if (this.focusNotesTaskId !== activeTaskId) {
      this.focusNotesTaskId = activeTaskId;
      this.focusNotes = "";
    }
    this.alert.textContent = this.error;
    this.alert.hidden = !this.error;
    this.navigation.replaceChildren();
    const views: [View, string][] = [
      ["today", "Today"],
      ...(!this.todayComplete ? [["focus", "Focus"] as [View, string]] : []),
      ["habits", "Overview"],
    ];
    if (this.todayComplete && this.view === "focus") this.view = "today";
    if (this.data?.canPlanTomorrow)
      views.splice(views.findIndex(([view]) => view === "habits"), 0, ["tomorrow", "Tomorrow"]);
    if (this.view === "tomorrow" && !this.data?.canPlanTomorrow)
      this.view = "today";
    const focusLocked = this.data?.activeTask != null && this.data.activeTask.startedAt !== null;
    if (focusLocked) this.view = "focus";
    this.profileButton.disabled = this.busy || focusLocked;
    this.profileButton.title = focusLocked ? "Pause the focus timer to access your profile" : "Profile";
    if (this.view === "profile") this.profileButton.setAttribute("aria-current", "page");
    else this.profileButton.removeAttribute("aria-current");
    this.root.dataset.view = this.view;
    this.root.classList.toggle("single-screen", this.view === "today" || this.view === "focus");
    for (const [view, title] of views) {
      const button = this.button(title, () => {
        this.pauseReasonOpen = false;
        this.view = view;
        this.render();
      });
      if (focusLocked && view !== "focus") {
        button.disabled = true;
        button.title = "Pause the focus timer to access other pages";
      }
      if (view === "today" && this.todayComplete) button.classList.add("day-complete");
      if (view === this.view) button.setAttribute("aria-current", "page");
      this.navigation.append(button);
    }
    this.navigation.classList.toggle("today-complete-selected", this.todayComplete && this.view === "today");
    this.updateNavigationIndicator();
    this.content.replaceChildren();
    if (this.view === "profile") {
      this.content.append(profilePage(this.email, this.data, () => this.signOut(), Math.floor((Date.now() + this.clockOffset) / 1000)));
      return;
    }
    if (!this.data) {
      this.content.append(this.button("Retry", () => this.refresh(false)));
      return;
    }
    if (this.view === "focus") this.renderFocus();
    else if (this.view === "habits") this.renderHabits();
    else this.renderPlan();
    this.tick();
    const complete = this.todayComplete;
    if (complete && this.completionState?.day === this.data.today && !this.completionState.complete) {
      this.celebrate();
    }
    this.completionState = { day: this.data.today, complete };
  }

  private celebrate(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const confetti = element("div", undefined, "confetti");
    confetti.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 250; i++) {
      const piece = element("span");
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.backgroundColor = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 300}px`);
      piece.style.animationDelay = `${Math.random() * 1.5}s`;
      piece.style.animationDuration = `${2.5 + Math.random() * 1.5}s`;
      confetti.append(piece);
    }
    document.body.append(confetti);
    window.setTimeout(() => confetti.remove(), 6000);
  }

  private updateNavigationIndicator(): void {
    const selected = this.navigation.querySelector<HTMLButtonElement>("button[aria-current]");
    this.navigation.classList.toggle("has-selection", selected !== null);
    if (!selected) return;
    this.navigation.style.setProperty("--selection-left", `${selected.offsetLeft}px`);
    this.navigation.style.setProperty("--selection-width", `${selected.offsetWidth}px`);
    this.navigation.style.setProperty("--selection-height", `${selected.offsetHeight}px`);
  }

  private async signOut(): Promise<void> {
    if (this.busy) return;
    if (this.client.pendingCount && !window.confirm("Some changes have not synced. They will stay on this device for this account, but will not sync while signed out. Sign out anyway?")) return;
    this.busy = true;
    this.error = "";
    this.alert.textContent = "";
    this.root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    const button = this.content.querySelector<HTMLButtonElement>(".danger-button");
    if (button) button.textContent = "Signing out…";
    try {
      await this.client.signOut();
      window.location.reload();
    } catch (error) {
      this.busy = false;
      this.error = this.message(error);
      this.render();
      this.alert.scrollIntoView({ block: "nearest" });
    }
  }

  private renderPlan(): void {
    const data = this.data!;
    const tomorrow = this.view === "tomorrow";
    const tasks = tomorrow ? data.tomorrowTasks : data.todayTasks;
    const day = tomorrow ? data.tomorrow : data.today;
    const heading = element("div", undefined, "plan-heading");
    const [year, month, date] = day.split("-");
    const dayLabel = element("time", `${date}/${month}/${year.slice(-2)}`, "plan-date");
    dayLabel.dateTime = day;
    heading.append(dayLabel);
    this.content.append(heading);
    const list = element("ul", undefined, "task-list");
    const priorityCompleted = tasks.some((task) => task.isPriority && task.status === "completed");
    const canChoosePriority = tasks.every((task) => task.status === "planned");
    for (const task of tasks) {
      const item = element("li", undefined, `task${task.isPriority ? " is-priority" : ""}`);
      const crown = this.button("👑", () => this.mutate(() => this.client.prioritize(task.id)));
      crown.className = "task-crown";
      crown.setAttribute("aria-label", task.isPriority ? "Most important task" : "Make most important task");
      crown.setAttribute("aria-pressed", String(task.isPriority));
      crown.title = task.isPriority ? "Most important task — complete this first" : "Make most important task";
      crown.disabled = this.busy || !canChoosePriority;
      item.append(crown);
      const details = element("div", undefined, "task-details");
      details.append(this.renderTaskTitle(task, "h2"));
      if (task.status === "completed" || (tomorrow && task.status !== "planned")) {
        details.append(
          element(
            "p",
            `${task.estimatedMinutes} min estimated · ${task.status}${task.status === "completed" ? ` · ${task.actualSeconds > 0 ? `${focusDuration(task.actualSeconds)} actual focus time` : "No focus time recorded"}` : ""}`,
            "muted",
          ),
        );
      }
      details.append(this.renderResources(task));
      item.append(details);
      if (task.status === "planned") {
        const estimate = estimateDial(task.estimatedMinutes, async (minutes) => {
          while (this.refreshing) await new Promise((resolve) => window.setTimeout(resolve, 25));
          await this.mutate(() => this.client.changeEstimate(task.id, minutes));
        });
        estimate.element.classList.add("task-estimate");
        if (this.busy) estimate.element.querySelector('[role="slider"]')?.setAttribute("aria-disabled", "true");
        item.append(estimate.element);
      }
      if (!tomorrow && task.status === "planned") {
        const start = this.button("Start focus", () =>
          this.mutate(async () => {
            await this.client.start(task.id);
            this.view = "focus";
          }),
        );
        start.disabled = this.busy || data.activeTask !== null || (!task.isPriority && !priorityCompleted);
        if (!task.isPriority && !priorityCompleted) start.title = "Complete the crowned task first";
        item.append(start);
      }
      if (task.status === "active")
        item.append(
          this.button("Return to focus", () => {
            this.view = "focus";
            this.render();
          }),
        );
      list.append(item);
    }
    this.content.append(list);
    if (tasks.length < PLANNER_LIMITS.tasksPerDay) this.renderForm(day);
  }

  private canEditTask(task: Task): boolean {
    return task.status === "planned" || (task.status === "active" && this.view === "focus");
  }

  private renderTaskTitle(task: Task, tag: "h1" | "h2"): HTMLElement {
    const heading = element(tag, undefined, "editable-title");
    if (!this.canEditTask(task)) {
      heading.append(element("span", task.outcome, "task-title-text"));
      return heading;
    }
    const edit = this.button("", () => {
      const input = element("input");
      input.value = task.outcome;
      input.maxLength = PLANNER_LIMITS.outcomeLength;
      input.setAttribute("aria-label", "Task title");
      let finished = false;
      const save = () => {
        if (finished) return;
        const outcome = input.value.trim();
        finished = true;
        if (!outcome || outcome === task.outcome) {
          heading.replaceChildren(edit);
          return;
        }
        void this.mutate(() => this.client.rename(task.id, outcome));
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          finished = true;
          heading.replaceChildren(edit);
          edit.focus();
        }
      });
      input.addEventListener("blur", save);
      heading.replaceChildren(input);
      input.focus();
      input.select();
    });
    edit.append(element("span", task.outcome, "task-title-text"));
    edit.title = `${task.outcome} — click to edit`;
    edit.setAttribute("aria-label", `Edit task title: ${task.outcome}`);
    heading.append(edit);
    return heading;
  }

  private renderResources(task: Task): HTMLElement {
    const section = element("section", undefined, "task-resources");
    section.setAttribute("aria-label", `Resources for ${task.outcome}`);
    let resourcesButton: HTMLButtonElement | undefined;
    if (task.resources.length) {
      // Resource collections can grow to 50 items. Keep them out of the page's
      // height budget, but fully accessible in a bounded native dialog.
      const dialog = element("dialog", undefined, "resource-dialog");
      dialog.setAttribute("aria-label", `Resources for ${task.outcome}`);
      const resourceError = element("p", "", "error");
      resourceError.setAttribute("role", "alert");
      const list = element("ul", undefined, "resource-list");
      for (const resource of task.resources) {
        const row = element("li");
        const open = this.button(`${resource.kind === "file" ? "File" : "Link"} · ${resource.label}`, async () => {
          try {
            await this.client.openResource(task.id, resource.id);
          } catch (error) {
            resourceError.textContent = this.message(error);
          }
        });
        open.title = resource.target;
        open.className = "resource-open";
        row.append(open);
        if (this.canEditTask(task)) {
          const remove = this.button("Remove", () => this.mutate(() => this.client.removeResource(task.id, resource.id)));
          remove.setAttribute("aria-label", `Remove ${resource.label} from task`);
          row.append(remove);
        }
        list.append(row);
      }
      dialog.append(element("h2", "Resources"), list, resourceError,
        this.button("Close resources", () => dialog.close()));
      section.append(dialog);
      resourcesButton = this.button(`Resources (${task.resources.length})`, () => dialog.showModal());
      resourcesButton.className = "resource-count";
      resourcesButton.setAttribute("aria-haspopup", "dialog");
    }
    if (!this.canEditTask(task)) {
      if (resourcesButton) section.append(resourcesButton);
      return section;
    }
    const form = element("form", undefined, "resource-form");
    if (resourcesButton) form.classList.add("has-resources");
    const url = element("input");
    url.type = "url";
    url.required = true;
    url.maxLength = PLANNER_LIMITS.resourceTargetLength;
    url.placeholder = "Paste a link and press Enter";
    url.setAttribute("aria-label", "Add a link; press Enter to save");
    url.disabled = this.busy;
    const save = element("button", "Add link");
    save.type = "submit";
    save.hidden = true;
    const attach = this.button("", () => this.mutate(() => this.client.attachFile(task.id)));
    attach.className = "resource-attach";
    attach.title = "Save a local file path (file contents stay on this device)";
    attach.setAttribute("aria-label", "Attach file");
    const icon = decorativeSvg("0 0 24 24");
    icon.append(svgElement("path", { d: "M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2" }));
    attach.append(icon);
    form.append(url, save, attach);
    if (resourcesButton) form.append(resourcesButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const target = url.value.trim();
      const parsed = new URL(target);
      const label = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, PLANNER_LIMITS.resourceLabelLength);
      void this.mutate(() => this.client.addLink(task.id, label, target), form);
    });
    section.append(form);
    return section;
  }

  private renderForm(day: string): void {
    const form = element("form", undefined, "task-form");
    const outcomeLabel = element("label");
    const outcome = element("input");
    outcome.setAttribute("aria-label", "Outcome");
    outcome.name = "outcome";
    outcome.required = true;
    outcome.maxLength = PLANNER_LIMITS.outcomeLength;
    outcome.placeholder = "Add an outcome";
    outcomeLabel.append(outcome);
    const estimate = estimateDial();
    const submit = element("button", undefined, "add-task");
    const plus = decorativeSvg("0 0 24 24");
    plus.append(svgElement("path", { d: "M12 3v18M3 12h18" }));
    submit.append(plus);
    submit.type = "submit";
    submit.title = "Add task";
    submit.setAttribute("aria-label", "Add task");
    submit.disabled = this.busy;
    form.append(outcomeLabel, estimate.element, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void this.mutate(
        () => this.client.create(outcome.value, day, estimate.minutes()),
        form,
      );
    });
    this.content.append(form);
  }

  private renderFocus(): void {
    const task = this.data!.activeTask;
    if (!task) {
      this.content.append(
        element("p", "Choose a task from Today to begin.", "muted"),
      );
      return;
    }
    const layout = element("div", undefined, "focus-layout");
    const details = element("div", undefined, "focus-details");
    details.append(this.renderTaskTitle(task, "h1"), this.renderResources(task));
    const notesSection = element("div", undefined, "focus-notes");
    const notesLabel = element("label", "Notes");
    const notes = element("textarea");
    notes.id = "focus-notes";
    notesLabel.htmlFor = notes.id;
    notes.rows = 5;
    notes.value = this.focusNotes;
    notes.addEventListener("input", () => { this.focusNotes = notes.value; });
    notesSection.append(notesLabel, notes);
    details.append(notesSection);
    layout.append(details);
    this.content.append(layout);
    const paused = task.startedAt === null;
    const timer = this.button("", async () => {
      if (paused) return this.mutate(() => this.client.resume(task.id));
      if (this.busy || this.refreshing) return;
      await this.mutate(async () => {
        // Pause immediately after the action is durably recorded in the local outbox.
        await this.client.stopTimer(task.id);
        this.pauseReasonOpen = true;
      });
      this.content.querySelector<HTMLTextAreaElement>(".pause-dialog textarea")?.focus();
    });
    timer.disabled = this.busy || this.pauseReasonOpen;
    timer.className = `timer${paused ? " is-paused" : ""}`;
    timer.id = "focus-timer";
    const svg = decorativeSvg("0 0 120 120");
    for (const className of ["timer-track", "timer-progress"]) {
      const circle = svgElement("circle", { cx: "60", cy: "60", r: String(FOCUS_RING_RADIUS), class: className });
      if (className === "timer-progress") circle.setAttribute("stroke-dasharray", String(FOCUS_RING_CIRCUMFERENCE));
      svg.append(circle);
    }
    const face = element("span", undefined, "timer-face");
    const time = element("span", "", "timer-value");
    time.id = "focus-time";
    face.append(time, element("span", paused ? "Paused · Click to resume" : "remaining · Click to pause", "timer-caption"));
    timer.append(svg, face);
    layout.append(timer);
    if (this.pauseReasonOpen && paused) {
      const dialog = element("dialog", undefined, "pause-dialog");
      dialog.setAttribute("aria-labelledby", "pause-reason-label");
      dialog.addEventListener("cancel", (event) => {
        // Escape may also be used to leave native fullscreen. Keep the
        // unfinished reason until the user explicitly saves or resumes.
        event.preventDefault();
      });
      const form = element("form", undefined, "pause-form");
      const label = element("label", "Why are you stopping?");
      label.id = "pause-reason-label";
      const reason = element("textarea");
      reason.required = true;
      reason.maxLength = PLANNER_LIMITS.stopReasonLength;
      reason.rows = 3;
      reason.placeholder = "e.g. Taking a break or handling an interruption";
      label.append(reason);
      const save = element("button", "Save reason");
      save.type = "submit";
      const cancel = this.button("Resume focusing", () => this.mutate(async () => {
        await this.client.resume(task.id);
        this.pauseReasonOpen = false;
      }));
      form.append(label, element("p", "The timer is paused while you write your reason.", "muted"), save, cancel);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        reason.setCustomValidity(reason.value.trim() ? "" : "Please write a reason for stopping.");
        if (!form.reportValidity()) return;
        void this.mutate(async () => {
          await this.client.savePauseReason(task.id, reason.value);
          this.pauseReasonOpen = false;
        }, form);
      });
      reason.addEventListener("input", () => reason.setCustomValidity(""));
      dialog.append(form);
      // Keep the modal outside the transformed focus layout so viewport
      // changes cannot affect its positioning in the desktop webview.
      this.content.append(dialog);
      dialog.showModal();
      reason.focus();
    }
    const actions = element("div", undefined, "focus-actions");
    details.append(actions);
    actions.append(
      this.button("Complete task", () =>
        this.mutate(async () => {
          await this.client.complete(task.id);
          this.pauseReasonOpen = false;
          this.view = "today";
        }),
      ),
    );
  }

  private renderHabits(): void {
    this.activityCalendar.update(this.data!.today, this.data!.completions);
    this.content.append(
      this.activityCalendar.element,
      this.weeklyReview.element,
    );
    void this.weeklyReview.refresh();
  }

  private tick(): void {
    const timer = document.getElementById("focus-timer");
    const task: Task | null = this.data?.activeTask ?? null;
    if (timer && task) {
      const now = Math.floor((Date.now() + this.clockOffset) / 1000);
      const remaining = Math.max(0, task.estimatedMinutes * 60 - trackedSeconds(task, now));
      const displayTime = formatDuration(remaining);
      const display = document.getElementById("focus-time");
      if (display) display.textContent = displayTime;
      timer.querySelector(".timer-progress")?.setAttribute("stroke-dashoffset", String(FOCUS_RING_CIRCUMFERENCE * (1 - remaining / (task.estimatedMinutes * 60))));
      timer.setAttribute("aria-label", `${displayTime} remaining. ${task.startedAt === null ? "Paused. Click to resume" : "Click to pause"}.`);
      timer.classList.toggle("is-overdue", remaining === 0);
      const caption = timer.querySelector(".timer-caption");
      if (caption && remaining === 0 && task.startedAt !== null) caption.textContent = "Time is up · Click to pause";
    }
  }

  private async mutate(
    action: () => Promise<unknown>,
    form?: HTMLFormElement,
  ): Promise<void> {
    if (this.busy || this.refreshing) return;
    this.busy = true;
    this.setControlsDisabled(true);
    this.error = "";
    try {
      await action();
      if (form) form.reset();
    } catch (error) {
      this.error = this.message(error);
    } finally {
      this.busy = false;
      // Read the local projection immediately; background sync reconciles server state.
      try {
        this.applyDashboard(await this.client.dashboard());
      } catch (error) {
        this.error = this.message(error);
      }
      // Preserve typed input on failure so it can be retried.
      if (this.error && form?.isConnected) {
        this.alert.textContent = this.error;
        this.alert.hidden = false;
        this.setControlsDisabled(false);
        if (this.data?.activeTask) {
          this.content
            .querySelectorAll<HTMLButtonElement>(".task button")
            .forEach((button) => {
              if (button.textContent === "Start focus") button.disabled = true;
            });
        }
      } else {
        this.render();
      }
    }
  }

  private setControlsDisabled(disabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>(PLANNER_BUTTONS).forEach((button) => { button.disabled = disabled; });
    this.root.querySelectorAll('[role="slider"]').forEach((slider) => {
      if (disabled) slider.setAttribute("aria-disabled", "true");
      else slider.removeAttribute("aria-disabled");
    });
  }

  private button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
    return actionButton(label, action, this.busy);
  }

  private message(error: unknown): string {
    return errorMessage(error, typeof error === "string" ? error : undefined);
  }
}

const root = document.getElementById("app")!;
const client = new PlanningClient();
void authenticate(root, client).then(async (account) => {
  if (account?.email) await new PlanningApplication(root, client, account.email).mount();
});
