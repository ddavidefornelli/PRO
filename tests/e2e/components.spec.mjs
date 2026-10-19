import { test, expect, open, add, synced } from "./fixtures.mjs";

async function dial(page) {
  await open(page);
  await page.evaluate(async () => {
    const { estimateDial } = await import("/src/estimate-dial.ts");
    window.commits = [];
    const { element } = estimateDial(30, (minutes) => window.commits.push(minutes));
    element.id = "isolated-dial";
    Object.assign(element.style, { position: "fixed", top: "100px", left: "16px", zIndex: "100" });
    document.body.append(element);
  });
  return page.locator("#isolated-dial [role=slider]");
}

test("dial keyboard matrix, unchanged commits, accessible values and disabled behavior", async ({ page }) => {
  const slider = await dial(page); await slider.focus();
  for (const [key, value] of [["ArrowRight", 35], ["ArrowDown", 30], ["PageUp", 45], ["PageDown", 30], ["End", 60], ["Home", 5]]) {
    await page.keyboard.press(key); await expect(slider).toHaveAttribute("aria-valuenow", String(value));
    await expect(slider).toHaveAttribute("aria-valuetext", `${value} minutes`);
  }
  expect(await page.evaluate(() => window.commits)).toEqual([35, 30, 45, 30, 60, 5]);
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("a");
  await slider.evaluate((node) => node.setAttribute("aria-disabled", "true")); await page.keyboard.press("End");
  expect(await page.evaluate(() => window.commits)).toHaveLength(6);
});

test("dial relative pointer movement never jumps on grab and commits exactly once on release", async ({ page }) => {
  const slider = await dial(page), box = await slider.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x + 20, y); await page.mouse.down();
  await expect(slider).toHaveAttribute("aria-valuenow", "30");
  await page.mouse.move(x, y + 20); await expect(slider).toHaveAttribute("aria-valuenow", "45");
  expect(await page.evaluate(() => window.commits)).toEqual([]);
  await page.mouse.up(); expect(await page.evaluate(() => window.commits)).toEqual([45]);
  await expect(slider).not.toHaveClass(/is-turning/);
});

test("dial ignores secondary/nonprimary pointers and disabled pointer input", async ({ page }) => {
  const slider = await dial(page);
  await slider.dispatchEvent("pointerdown", { isPrimary: false, button: 0, pointerId: 9 });
  await slider.dispatchEvent("pointermove", { pointerId: 9, clientX: 999, clientY: 999 });
  await slider.dispatchEvent("pointerup", { pointerId: 9 });
  await slider.dispatchEvent("pointerdown", { isPrimary: true, button: 2, pointerId: 10 });
  await slider.evaluate((node) => node.setAttribute("aria-disabled", "true"));
  await slider.click({ force: true }); await expect(slider).toHaveAttribute("aria-valuenow", "30");
  expect(await page.evaluate(() => window.commits)).toEqual([]);
});

test("pause dialog rejects blank reasons, Escape keeps the task paused, resume restores focus lock", async ({ page }) => {
  await open(page); await add(page, "Pause safely"); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).click();
  await page.locator("#focus-timer").click();
  await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("   ");
  await page.getByRole("button", { name: "Save reason" }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Why are you stopping?" })).toHaveValue("   ");
  await expect(page.locator("#focus-timer")).toHaveClass(/is-paused/);
  await page.getByRole("button", { name: "Resume focusing" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#focus-timer")).not.toHaveClass(/is-paused/);
  await expect(page.getByRole("navigation").getByRole("button", { name: "Today", exact: true })).toBeDisabled();
});

test("restarting an overdue server timer clamps remaining time to zero instead of going negative", async ({ page, backend }) => {
  const task = await backend.create("Long-running timer"); await backend.call("start_task", { id: task.id });
  await backend.db.query("update public.planner_tasks set started_at = started_at - 7200 where id = $1", [task.id]);
  await page.goto("/"); await expect(page.locator("#focus-time")).toHaveText("00:00:00");
  await expect(page.locator("#focus-timer")).toHaveClass(/is-overdue/);
  await expect(page.locator(".timer-caption")).toHaveText("Time is up · Click to pause");
});

test("durable AI report renders source evidence and hostile text literally, not as HTML", async ({ page, backend }) => {
  const report = {
    weekStart: "2026-10-05", weekEnd: "2026-10-11", generatedAt: 1791806400, model: "gpt-4.1-mini",
    activity: { tasks: [{ id: "task", outcome: "<script>bad()</script>", plannedFor: "2026-10-05", completedOn: "2026-10-06", status: "completed", estimatedMinutes: 30, actualSeconds: 90 }],
      stops: [{ id: 1, taskId: "task", reason: "<img src=https://attacker.invalid/evil>", stoppedOn: "2026-10-05" }], totalStops: 5, omittedStops: 4 },
    analysis: { summary: "<iframe src=https://attacker.invalid>", mainReasons: [{ reason: "Reported rest", evidenceStopIds: [1] }], improvements: ["Keep logging"] },
  };
  await backend.db.query("insert into public.planner_reviews(user_id, week_start, report) values ('00000000-0000-4000-8000-000000000001', $1, $2::jsonb)", [report.weekStart, JSON.stringify(report)]);
  await open(page); await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".weekly-summary")).toHaveCount(0);
  await expect(page.locator(".weekly-report")).not.toContainText(report.analysis.summary);
  await expect(page.locator(".weekly-report")).not.toContainText("2026");
  await expect(page.locator(".review-stats dd")).toHaveText(["1", "5", "1"]);
  await expect(page.locator(".weekly-improvements li")).toHaveText(["Keep logging"]);
  await expect(page.locator(".review-bar-estimate")).toHaveAttribute("style", "width: 100%;");
  await expect(page.locator(".review-bar-actual")).toHaveAttribute("style", "width: 5%;");
  await expect(page.locator(".review-count")).toHaveText("1 entry");
  await expect(page.locator(".review-timing-delta")).toHaveText("Outside margin · 28m 30s under estimate");
  await expect(page.locator(".review-timing-comparison")).toHaveClass(/is-red/);
  await expect(page.locator(".review-timing-label")).toHaveText(["Average estimate", "Average actual"]);
  await expect(page.locator(".review-timing-value")).toHaveText(["30m", "1m 30s"]);
  await expect(page.locator(".weekly-report")).toContainText("4 earlier stops were omitted");
  await page.getByText("View 1 supporting stop entry", { exact: true }).click();
  await expect(page.getByText(report.activity.stops[0].reason, { exact: true }).first()).toBeVisible();
  await expect(page.locator(".weekly-report img, .weekly-report iframe, .weekly-report script")).toHaveCount(0);
});

test("stale weekly read cannot overwrite a newer consent change", async ({ page }) => {
  await open(page);
  const output = await page.evaluate(async () => {
    const { WeeklyReviewPanel } = await import("/src/weekly-review.ts");
    const data = { settings: { enabled: false }, model: "gpt-4.1-mini", available: true, week: { start: "2026-10-05", end: "2026-10-11", nextUpdate: "2026-10-19" }, status: "disabled", error: null, reviews: [] };
    let release;
    let reads = 0;
    const client = {
      weeklyOverview: () => ++reads === 1 ? Promise.resolve(data) : new Promise((resolve) => { release = resolve; }),
      setWeeklyAiEnabled: async () => ({ ...data, settings: { enabled: true }, status: "no_data" }),
      generateIfDue: async () => { throw { message: "Fixture unavailable" }; },
    };
    const panel = new WeeklyReviewPanel(client); document.body.append(panel.element);
    await panel.refresh(); const staleRead = panel.refresh();
    panel.element.querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(data); await staleRead;
    return { review: panel.element.textContent, settings: panel.settingsElement.textContent };
  });
  expect(output.settings).toContain("Disable weekly AI");
  expect(output.review).not.toContain("Weekly AI is off.");
  expect(output.review).not.toContain("Review settings & privacy");
});
