import { isTauri } from "@tauri-apps/api/core";
import { PlanningClient, type Dashboard, type Task } from "./api";
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
  private readonly navigation = element("nav");
  private readonly content = element("main");
  private readonly alert = element("p", "", "error");

  constructor(
    private readonly root: HTMLElement,
    private readonly client: PlanningClient,
  ) {}

  async mount(): Promise<void> {
    const header = element("header");
    header.append(
      element("strong", "PRO"),
      element("span", "Less planning. Meaningful progress.", "muted"),
    );
    this.navigation.setAttribute("aria-label", "Main navigation");
    this.alert.setAttribute("role", "alert");
    this.root.append(header, this.navigation, this.alert, this.content);
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
    if (this.busy || this.refreshing) return;
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
      ["focus", "Focus"],
      ["habits", "Habit tracker"],
    ];
    if (this.data?.canPlanTomorrow)
      views.splice(2, 0, ["tomorrow", "Tomorrow"]);
    if (this.view === "tomorrow" && !this.data?.canPlanTomorrow)
      this.view = "today";
    for (const [view, title] of views) {
      const button = this.button(title, () => {
        this.view = view;
        this.render();
      });
      if (view === this.view) button.setAttribute("aria-current", "page");
      this.navigation.append(button);
    }
    this.content.replaceChildren();
    if (!this.data) {
      this.content.append(element("h1", "Your day, with intention."));
      if (isTauri())
        this.content.append(this.button("Retry", () => this.refresh(false)));
      return;
    }
    if (this.view === "focus") this.renderFocus();
    else if (this.view === "habits") this.renderHabits();
    else this.renderPlan();
    this.tick();
  }

  private renderPlan(): void {
    const data = this.data!;
    const tomorrow = this.view === "tomorrow";
    const tasks = tomorrow ? data.tomorrowTasks : data.todayTasks;
    const day = tomorrow ? data.tomorrow : data.today;
    this.content.append(
      element("p", day, "eyebrow"),
      element(
        "h1",
        tomorrow ? "Make room for tomorrow." : "What matters today?",
      ),
    );
    this.content.append(
      element(
        "p",
        `${tasks.length} / 3 important tasks. Choose a clear, achievable outcome.`,
        "muted",
      ),
    );
    const list = element("ul", undefined, "task-list");
    for (const task of tasks) {
      const item = element("li", undefined, "task");
      const details = element("div");
      details.append(element("h2", task.outcome));
      details.append(
        element(
          "p",
          `${task.estimatedMinutes} min estimated · ${task.status}${task.status === "completed" ? ` · ${this.duration(task.actualSeconds)} spent` : ""}`,
          "muted",
        ),
      );
      item.append(details);
      if (!tomorrow && task.status === "planned") {
        const start = this.button("Start focus", () =>
          this.mutate(async () => {
            await this.client.start(task.id);
            this.view = "focus";
          }),
        );
        start.disabled = this.busy || data.activeTask !== null;
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
    if (!tomorrow && data.canPlanTomorrow) {
      this.content.append(
        element(
          "p",
          "Today's work is complete. Take a breath, then plan tomorrow.",
          "success",
        ),
      );
    }
  }

  private renderForm(day: string): void {
    const form = element("form", undefined, "task-form");
    const outcomeLabel = element("label", "Outcome");
    const outcome = element("input");
    outcome.name = "outcome";
    outcome.required = true;
    outcome.maxLength = 500;
    outcome.placeholder = "e.g. Write and send the project proposal";
    outcomeLabel.append(outcome);
    const estimateLabel = element("label", "Estimated minutes");
    const estimate = element("input");
    estimate.type = "number";
    estimate.name = "estimate";
    estimate.min = "1";
    estimate.max = "1440";
    estimate.step = "1";
    estimate.value = "30";
    estimate.required = true;
    estimateLabel.append(estimate);
    const submit = element("button", "Add task");
    submit.type = "submit";
    submit.disabled = this.busy;
    form.append(outcomeLabel, estimateLabel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void this.mutate(
        () => this.client.create(outcome.value, day, Number(estimate.value)),
        form,
      );
    });
    this.content.append(form);
  }

  private renderFocus(): void {
    const task = this.data!.activeTask;
    this.content.append(element("p", "ONE THING AT A TIME", "eyebrow"));
    if (!task) {
      this.content.append(
        element("h1", "Ready when you are."),
        element("p", "Choose a task from Today to begin.", "muted"),
      );
      return;
    }
    this.content.append(element("h1", task.outcome));
    const timer = element("p", "", "timer");
    timer.id = "focus-timer";
    timer.setAttribute("aria-label", "Elapsed focus time");
    this.content.append(
      timer,
      element("p", "Time includes sleep and app restarts.", "muted"),
    );
    this.content.append(
      this.button("Complete task", () =>
        this.mutate(async () => {
          await this.client.complete(task.id);
          this.view = "today";
        }),
      ),
    );
  }

  private renderHabits(): void {
    this.content.append(
      element("h1", "Small wins, over time."),
      element(
        "p",
        "Completed tasks over the last 52 weeks. Each square is a day.",
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
        `${total} tasks completed. Progress, not perfection.`,
        "muted",
      ),
    );
  }

  private tick(): void {
    const timer = document.getElementById("focus-timer");
    const task: Task | null = this.data?.activeTask ?? null;
    if (timer && task?.startedAt != null) {
      const now = Math.floor((Date.now() + this.clockOffset) / 1000);
      timer.textContent = this.duration(
        task.actualSeconds + Math.max(0, now - task.startedAt),
      );
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
