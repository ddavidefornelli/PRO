import { test, expect, open } from "./fixtures.mjs";

test("a busy week shows only two average bars, not a task list", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { WeeklyReviewPanel } = await import("/src/weekly-review.ts");
    const review = {
      weekStart: "2026-10-12", weekEnd: "2026-10-18", generatedAt: 1792368000, model: "test",
      activity: {
        tasks: Array.from({ length: 24 }, (_, i) => ({ id: String(i), outcome: `Task ${i}`,
          plannedFor: "2026-10-12", completedOn: "2026-10-13", status: "completed",
          estimatedMinutes: 30, actualSeconds: 1860 })),
        stops: [], totalStops: 0, omittedStops: 0,
      },
      analysis: { summary: "A busy week.", mainReasons: [], improvements: ["Protect focus time."] },
    };
    const panel = new WeeklyReviewPanel({ weeklyOverview: async () => ({
      settings: { enabled: true }, model: "test", available: true,
      week: { start: review.weekStart, end: review.weekEnd, nextUpdate: "2026-10-26" },
      status: "up_to_date", error: null, reviews: [review],
    }) });
    panel.element.id = "timing-fixture";
    document.body.append(panel.element);
    await panel.refresh();
  });
  const timing = page.locator("#timing-fixture .review-timing-comparison");
  await expect(timing).toHaveClass(/is-green/);
  await expect(timing.locator(".review-bar-track")).toHaveCount(2);
  await expect(timing.locator(".review-timing-value")).toHaveText(["30m", "31m"]);
  await expect(timing).toContainText("24 completed tasks");
  await expect(timing).toContainText("Within margin");
  await expect(timing).not.toContainText("Task 0");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await timing.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
