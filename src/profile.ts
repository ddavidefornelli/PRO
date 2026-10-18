import type { Dashboard } from "./api";
import { ActivityCalendar } from "./activity-calendar";
import { profileStats } from "./profile-stats";

import { actionButton, decorativeSvg, element as node, svgElement } from "./dom";

export function profileIcon(): SVGSVGElement {
  const svg = decorativeSvg("0 0 24 24");
  svg.append(svgElement("circle", { cx: "12", cy: "8", r: "4" }),
    svgElement("path", { d: "M4 21v-2a8 8 0 0 1 16 0v2" }));
  return svg;
}

function focusDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function statGrid(metrics: [string, string][]): HTMLDListElement {
  const grid = node("dl", undefined, "profile-stats");
  for (const [label, value] of metrics) {
    const card = node("div", undefined, "profile-stat");
    card.append(node("dt", label), node("dd", value));
    grid.append(card);
  }
  return grid;
}

export function profilePage(
  email: string,
  data: Dashboard | null,
  signOut: () => Promise<void>,
  now: number,
): HTMLElement {
  const section = node("section", undefined, "profile-page");
  section.setAttribute("aria-labelledby", "profile-heading");
  const header = node("header", undefined, "profile-heading");
  const heading = node("h1", "Profile");
  heading.id = "profile-heading";
  header.append(heading, node("p", email, "profile-email"));
  section.append(header);

  if (data) {
    const stats = profileStats(data, now);
    section.append(
      node("h2", "All time", "profile-section-heading"),
      statGrid([
        ["Tasks completed", stats.totalCompleted.toLocaleString()],
        ["Active days", stats.activeDays.toLocaleString()],
        ["Current streak", `${stats.currentStreak} ${stats.currentStreak === 1 ? "day" : "days"}`],
        ["Best streak", `${stats.bestStreak} ${stats.bestStreak === 1 ? "day" : "days"}`],
      ]),
      node("h2", "Recent activity", "profile-section-heading"),
      statGrid([
        ["Completed today", stats.todayCompleted.toLocaleString()],
        ["Completed this week", stats.weekCompleted.toLocaleString()],
        ["Completed this month", stats.monthCompleted.toLocaleString()],
        ["Today’s task focus", focusDuration(stats.todayFocusSeconds)],
      ]),
      node("p", `Today’s plan: ${data.todayTasks.filter((task) => task.status === "completed").length}/${data.todayTasks.length} complete · ${focusDuration(stats.todayEstimatedMinutes * 60)} estimated`, "muted"),
    );
    const calendar = new ActivityCalendar();
    calendar.update(data.today, data.completions);
    section.append(calendar.element);
  } else {
    section.append(node("p", "Stats unavailable.", "muted"));
  }

  const footer = node("footer", undefined, "profile-footer");
  const button = actionButton("Sign out", signOut);
  button.className = "danger-button";
  footer.append(button);
  section.append(footer);
  return section;
}
