import { isTauri } from "@tauri-apps/api/core";
import { PlanningClient, type Dashboard, type Task } from "./api";
import { estimateDial } from "./estimate-dial";
import "./styles.css";

type View = "today" | "focus" | "tomorrow" | "habits";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

class PlanningApplication {
  private data: Dashboard | null = null;
  private view: View = "today";
  private busy = false;
  private refreshing = false;
  private error = "";
  private clockOffset = 0;
  private pauseReasonOpen = false;
  private completionState: { day: string; complete: boolean } | null = null;

  private get todayComplete(): boolean {
    const tasks = this.data?.todayTasks ?? [];
    return tasks.length > 0 && tasks.every((task) => task.status === "completed");
  }
  private readonly navigation = element("nav");
  private readonly content = element("main");
  private readonly alert = element("p", "", "error");

  constructor(
    private readonly root: HTMLElement,
    private readonly client: PlanningClient,
  ) {}

  async mount(): Promise<void> {
    this.navigation.setAttribute("aria-label", "Main navigation");
    this.alert.setAttribute("role", "alert");
    this.root.append(this.navigation, this.alert, this.content);
    new ResizeObserver(() => this.updateNavigationIndicator()).observe(this.navigation);
    if (!isTauri()) {
      this.error =
        "Open PRO as a desktop app with npm run desktop. Browser preview cannot access your local database.";
      this.render();
      return;
    }
    await this.refresh(true);
    window.setInterval(() => this.tick(), 1000);
    // Refresh after sleep/date rollover without replacing an in-progress form.
    window.setInterval(() => {
      void this.refresh(false);
    }, 30_000);
    window.addEventListener("focus", () => {
      void this.refresh(false);
    });
  }

  private async refresh(initial: boolean): Promise<void> {
    if (this.busy || this.refreshing || this.pauseReasonOpen) return;
    this.refreshing = true;
    try {
      const next = await this.client.dashboard();
      const changed =
        JSON.stringify(this.data && { ...this.data, serverNow: 0 }) !==
        JSON.stringify({ ...next, serverNow: 0 });
      this.clockOffset = next.serverNow * 1000 - Date.now();
      this.data = next;
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
    }
  }

  private render(): void {
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
    if (!this.data) {
      if (isTauri())
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
    const colors = ["#30d158", "#0a84ff", "#ffd60a", "#ff375f", "#bf5af2"];
    for (let i = 0; i < 100; i++) {
      const piece = element("span");
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.backgroundColor = colors[i % colors.length];
      piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 300}px`);
      piece.style.animationDelay = `${Math.random() * 0.7}s`;
      piece.style.animationDuration = `${2.2 + Math.random() * 1.3}s`;
      confetti.append(piece);
    }
    document.body.append(confetti);
    window.setTimeout(() => confetti.remove(), 4500);
  }

  private updateNavigationIndicator(): void {
    const selected = this.navigation.querySelector<HTMLButtonElement>("button[aria-current]");
    if (!selected) return;
    this.navigation.style.setProperty("--selection-left", `${selected.offsetLeft}px`);
    this.navigation.style.setProperty("--selection-width", `${selected.offsetWidth}px`);
    this.navigation.style.setProperty("--selection-height", `${selected.offsetHeight}px`);
    this.navigation.classList.add("has-selection");
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
    const title = element("div", undefined, "plan-title");
    title.append(element("h1", tomorrow ? "Tomorrow" : "Today"));
    heading.append(title, dayLabel);
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
      if (tomorrow && task.status !== "planned") {
        details.append(
          element(
            "p",
            `${task.estimatedMinutes} min estimated · ${task.status}${task.status === "completed" ? ` · ${this.duration(task.actualSeconds)} spent` : ""}`,
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
    if (tasks.length < 3) this.renderForm(day);
  }

  private renderTaskTitle(task: Task, tag: "h1" | "h2"): HTMLElement {
    const heading = element(tag, undefined, "editable-title");
    const edit = this.button(task.outcome, () => {
      const input = element("input");
      input.value = task.outcome;
      input.maxLength = 500;
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
    edit.title = "Click to edit task title";
    edit.setAttribute("aria-label", `Edit task title: ${task.outcome}`);
    heading.append(edit);
    return heading;
  }

  private renderResources(task: Task): HTMLElement {
    const section = element("section", undefined, "task-resources");
    section.setAttribute("aria-label", `Resources for ${task.outcome}`);
    if (task.resources.length) {
      const list = element("ul", undefined, "resource-list");
      for (const resource of task.resources) {
        const row = element("li");
        const open = this.button(`${resource.kind === "file" ? "File" : "Link"} · ${resource.label}`, async () => {
          try {
            await this.client.openResource(task.id, resource.id);
          } catch (error) {
            this.alert.textContent = this.message(error);
            this.alert.hidden = false;
          }
        });
        open.title = resource.target;
        open.className = "resource-open";
        const remove = this.button("Remove", () => this.mutate(() => this.client.removeResource(task.id, resource.id)));
        remove.setAttribute("aria-label", `Remove ${resource.label} from task`);
        row.append(open, remove);
        list.append(row);
      }
      section.append(list);
    }
    const form = element("form", undefined, "resource-form");
    const url = element("input");
    url.type = "url";
    url.required = true;
    url.maxLength = 8192;
    url.placeholder = "Paste a link and press Enter";
    url.setAttribute("aria-label", "Add a link; press Enter to save");
    url.disabled = this.busy;
    const save = element("button", "Add link");
    save.type = "submit";
    save.hidden = true;
    const attach = this.button("", () => this.mutate(() => this.client.attachFile(task.id)));
    attach.className = "resource-attach";
    attach.title = "Attach file";
    attach.setAttribute("aria-label", "Attach file");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(icon.namespaceURI, "path");
    path.setAttribute("d", "M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2");
    icon.append(path);
    attach.append(icon);
    form.append(url, save, attach);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const target = url.value.trim();
      const parsed = new URL(target);
      const label = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 200);
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
    outcome.maxLength = 500;
    outcome.placeholder = "Add an outcome";
    outcomeLabel.append(outcome);
    const estimate = estimateDial();
    const submit = element("button", "+", "add-task");
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
    details.append(element("h1", task.outcome), this.renderResources(task));
    layout.append(details);
    this.content.append(layout);
    const paused = task.startedAt === null;
    const timer = this.button("", async () => {
      if (paused) return this.mutate(() => this.client.resume(task.id));
      if (this.busy || this.refreshing) return;
      await this.mutate(async () => {
        // Freeze the display immediately; the saved state is read back on failure.
        const now = Math.floor((Date.now() + this.clockOffset) / 1000);
        task.actualSeconds += Math.max(0, now - task.startedAt!);
        task.startedAt = null;
        this.tick();
        await this.client.stopTimer(task.id);
        this.pauseReasonOpen = true;
      });
      this.content.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
    timer.disabled = this.busy || this.pauseReasonOpen;
    timer.className = `timer${paused ? " is-paused" : ""}`;
    timer.id = "focus-timer";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("aria-hidden", "true");
    for (const className of ["timer-track", "timer-progress"]) {
      const circle = document.createElementNS(svg.namespaceURI, "circle");
      circle.setAttribute("cx", "60");
      circle.setAttribute("cy", "60");
      circle.setAttribute("r", "54");
      circle.setAttribute("class", className);
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
        event.preventDefault();
        this.pauseReasonOpen = false;
        this.render();
      });
      const form = element("form", undefined, "pause-form");
      const label = element("label", "Why are you stopping?");
      label.id = "pause-reason-label";
      const reason = element("textarea");
      reason.required = true;
      reason.maxLength = 1000;
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
      details.append(dialog);
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
    this.content.append(
      element("h1", "Overview"),
      element(
        "p",
        "Last 52 weeks · One square per day",
        "muted",
      ),
    );
    const counts = new Map(
      this.data!.completions.map((entry) => [entry.day, entry.count]),
    );
    const grid = element("div", undefined, "habit-grid");
    grid.setAttribute("role", "list");
    grid.setAttribute("aria-label", "Daily task completions");
    const end = new Date(`${this.data!.today}T12:00:00Z`);
    for (let daysAgo = 363; daysAgo >= 0; daysAgo--) {
      const date = new Date(end);
      date.setUTCDate(date.getUTCDate() - daysAgo);
      const day = date.toISOString().slice(0, 10);
      const count = counts.get(day) ?? 0;
      const cell = element(
        "span",
        undefined,
        `habit level-${Math.min(count, 3)}`,
      );
      cell.title = `${day}: ${count} completed`;
      cell.setAttribute("aria-label", cell.title);
      cell.setAttribute("role", "listitem");
      grid.append(cell);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    this.content.append(
      grid,
      element(
        "p",
        `${total} tasks completed`,
        "muted",
      ),
    );
  }

  private tick(): void {
    const timer = document.getElementById("focus-timer");
    const task: Task | null = this.data?.activeTask ?? null;
    if (timer && task) {
      const now = Math.floor((Date.now() + this.clockOffset) / 1000);
      const elapsed = task.actualSeconds + (task.startedAt === null ? 0 : Math.max(0, now - task.startedAt));
      const remaining = Math.max(0, task.estimatedMinutes * 60 - elapsed);
      const display = document.getElementById("focus-time");
      if (display) display.textContent = this.duration(remaining);
      const progress = timer.querySelector(".timer-progress");
      const circumference = 2 * Math.PI * 54;
      progress?.setAttribute("stroke-dasharray", String(circumference));
      progress?.setAttribute("stroke-dashoffset", String(circumference * (1 - remaining / (task.estimatedMinutes * 60))));
      timer.setAttribute("aria-label", `${this.duration(remaining)} remaining. ${task.startedAt === null ? "Paused. Click to resume" : "Click to pause"}.`);
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
    this.root.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    this.root.querySelectorAll('[role="slider"]').forEach((slider) => slider.setAttribute("aria-disabled", "true"));
    this.error = "";
    try {
      await action();
      if (form) form.reset();
    } catch (error) {
      this.error = this.message(error);
    } finally {
      this.busy = false;
      // Read back saved state. Never show optimistic changes that failed to persist.
      try {
        this.data = await this.client.dashboard();
        this.clockOffset = this.data.serverNow * 1000 - Date.now();
      } catch (error) {
        this.error = this.message(error);
      }
      // Preserve typed input on failure so it can be retried.
      if (this.error && form?.isConnected) {
        this.alert.textContent = this.error;
        this.alert.hidden = false;
        this.root.querySelectorAll('[role="slider"]').forEach((slider) => slider.removeAttribute("aria-disabled"));
        this.root.querySelectorAll("button").forEach((button) => {
          button.disabled = false;
        });
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

  private button(
    label: string,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = element("button", label);
    button.type = "button";
    button.disabled = this.busy;
    button.addEventListener("click", () => {
      void action();
    });
    return button;
  }

  private duration(seconds: number): string {
    return [
      Math.floor(seconds / 3600),
      Math.floor(seconds / 60) % 60,
      seconds % 60,
    ]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  private message(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error)
      return String(error.message);
    return typeof error === "string"
      ? error
      : "Something went wrong. Please try again.";
  }
}

void new PlanningApplication(
  document.getElementById("app")!,
  new PlanningClient(),
).mount();
