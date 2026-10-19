import type { Dashboard } from "./api";
import { element } from "./dom.ts";
import { DAY_MS } from "./time.ts";

type Completion = Dashboard["completions"][number];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateLabel = new Intl.DateTimeFormat("en", {
  month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
});

export function calendarYear(year: number, today: string, completions: Completion[], startMonth = 0) {
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year + 1, startMonth, 0));
  const offset = start.getUTCDay();
  const dayCount = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const weeks = Math.ceil((offset + dayCount) / 7);
  const counts = new Map(completions.map(({ day, count }) => [day, count]));
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const day = date.toISOString().slice(0, 10);
    return {
      day,
      row: date.getUTCDay(),
      week: Math.floor((offset + index) / 7),
      count: day <= today ? (counts.get(day) ?? 0) : 0,
      future: day > today,
      month: date.getUTCMonth(),
    };
  });
  return { weeks, days, total: days.reduce((sum, day) => sum + day.count, 0) };
}

export class ActivityCalendar {
  readonly element = element("section", undefined, "activity-calendar");

  update(today: string, completions: Completion[]): void {
    const year = Number(today.slice(0, 4));
    const startMonth = Number(today.slice(5, 7)) - 1;
    const { weeks, days, total } = calendarYear(year, today, completions, startMonth);
    const endMonth = (startMonth + 11) % 12;
    const endYear = startMonth === 0 ? year : year + 1;
    this.element.replaceChildren();
    this.element.setAttribute("aria-label", "Task completion history");

    const chart = element("div", undefined, "activity-chart");
    const heading = element("h2", `${total.toLocaleString()} ${total === 1 ? "task" : "tasks"} completed in ${MONTHS[startMonth]} ${year} – ${MONTHS[endMonth]} ${endYear}`, "activity-heading");
    heading.id = "activity-heading";
    const card = element("div", undefined, "activity-card");
    const scroll = element("div", undefined, "activity-scroll");
    const grid = element("div", undefined, "activity-grid");
    grid.style.setProperty("--weeks", String(weeks));
    grid.setAttribute("role", "list");
    grid.setAttribute("aria-labelledby", heading.id);

    for (let index = 0; index < 12; index++) {
      const month = (startMonth + index) % 12;
      const first = days.find((day) => day.month === month)!;
      const next = index < 11 ? days.find((day) => day.month === (month + 1) % 12) : undefined;
      const label = element("span", MONTHS[month], "activity-month");
      label.style.gridRow = "1";
      label.style.gridColumn = `${first.week + 1} / span ${(next?.week ?? weeks) - first.week}`;
      label.setAttribute("aria-hidden", "true");
      grid.append(label);
    }

    const focusable: HTMLElement[] = [];
    for (const day of days) {
      const cell = element("span", undefined, `activity-day activity-level-${Math.min(day.count, 3)}${day.future ? " is-future" : ""}`);
      cell.style.gridRow = String(day.row + 2);
      cell.style.gridColumn = String(day.week + 1);
      const formatted = dateLabel.format(new Date(`${day.day}T00:00:00Z`));
      cell.title = day.future ? `${formatted} — upcoming` : `${day.count} ${day.count === 1 ? "task" : "tasks"} completed on ${formatted}`;
      cell.setAttribute("role", "listitem");
      cell.setAttribute("aria-label", cell.title);
      if (day.day === today) {
        cell.classList.add("is-today");
        cell.setAttribute("aria-current", "date");
      }
      if (!day.future) {
        cell.tabIndex = -1;
        focusable.push(cell);
      }
      grid.append(cell);
    }
    // A single tab stop; arrow keys follow the calendar's weekday/week layout.
    focusable.at(-1)!.tabIndex = 0;
    grid.addEventListener("keydown", (event) => {
      const index = focusable.indexOf(event.target as HTMLElement);
      if (index < 0) return;
      const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
      const next = event.key === "Home" ? 0 : event.key === "End" ? focusable.length - 1 : delta === undefined ? null : Math.max(0, Math.min(focusable.length - 1, index + delta));
      if (next === null) return;
      event.preventDefault();
      focusable[index].tabIndex = -1;
      focusable[next].tabIndex = 0;
      focusable[next].focus();
    });
    scroll.append(grid);

    const footer = element("div", undefined, "activity-footer");
    const legend = element("div", undefined, "activity-legend");
    legend.setAttribute("aria-label", "Daily completions: no tasks, one task, two tasks, three or more tasks");
    legend.append(element("span", "Less"));
    for (let level = 0; level <= 3; level++) {
      const swatch = element("span", undefined, `activity-day activity-level-${level}`);
      swatch.setAttribute("aria-hidden", "true");
      legend.append(swatch);
    }
    legend.append(element("span", "More"));
    footer.append(legend);
    card.append(scroll, footer);
    chart.append(heading, card);

    this.element.append(chart);
  }
}
