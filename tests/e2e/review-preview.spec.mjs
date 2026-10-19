import { test, expect, open } from "./fixtures.mjs";

test("on-demand button generates a current-week preview and keeps saved reports separate", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { WeeklyReviewPanel } = await import("/src/weekly-review.ts");
    const data = { settings: { enabled: true }, model: "gpt-4.1-mini", available: true,
      week: { start: "2026-10-12", end: "2026-10-18", nextUpdate: "2026-10-26" }, status: "no_data", error: null, reviews: [] };
    const client = {
      weeklyOverview: async () => data,
      previewReview: () => new Promise((resolve) => { window.releasePreview = () => resolve({ review: {
        weekStart: "2026-10-19", weekEnd: "2026-10-21", generatedAt: 1792584000, model: "gpt-4.1-mini",
        activity: { tasks: [{ id: "a", outcome: "Write report", plannedFor: "2026-10-19", completedOn: "2026-10-20", status: "completed", estimatedMinutes: 30, actualSeconds: 2400 }], stops: [], totalStops: 0, omittedStops: 0 },
        analysis: { summary: "A partial week with one completion.", mainReasons: [], improvements: ["Try a 40-minute estimate."] },
      } }); }),
    };
    const panel = new WeeklyReviewPanel(client);
    panel.element.id = "preview-fixture";
    document.body.append(panel.element);
    await panel.refresh();
  });
  const panel = page.locator("#preview-fixture");
  await expect(panel.locator(".weekly-settings")).toHaveCount(0);
  await expect(panel).not.toContainText("Your week at a glance");
  await expect(panel).not.toContainText("No tasks or stops were recorded");
  await expect(panel.getByRole("button")).toHaveCount(1);
  await panel.getByRole("button", { name: "Review this week so far" }).click();
  await expect(panel.getByRole("button", { name: "Creating review…" })).toBeDisabled();
  await page.evaluate(() => window.releasePreview());
  await expect(panel.locator(".weekly-preview")).toContainText("Try a 40-minute estimate.");
  await expect(panel.locator(".weekly-preview")).not.toContainText("A partial week with one completion.");
  await expect(panel.locator(".weekly-preview")).not.toContainText("2026");
  await expect(panel.locator(".review-timing-delta")).toHaveText("Outside margin · 10m over estimate");
  await expect(panel.locator(".review-timing-comparison")).toHaveClass(/is-orange/);
  await expect(panel.locator(".review-timing-label")).toHaveText(["Average estimate", "Average actual"]);
  await expect(panel.locator(".review-timing-value")).toHaveText(["30m", "40m"]);
  await expect(panel.locator(".weekly-preview h4")).toHaveText([
    "Reduce distractions · Try next week",
    "Estimated vs actual task time",
    "Comprehensive review",
  ]);
  expect(await panel.locator(".weekly-preview").evaluate((element) => {
    const content = element.textContent;
    return content.indexOf("10m over estimate") < content.indexOf("Comprehensive review");
  })).toBe(true);
  await expect(panel.getByRole("button", { name: "Review this week so far" })).toBeEnabled();
  await expect(panel).not.toContainText("Your on-demand review is ready");
  await expect(panel).not.toContainText("On-demand preview");
  await expect(panel.locator(".review-sources, .weekly-disclaimer")).toHaveCount(0);
});

test("preview requires consent and safely displays no-data and quota feedback", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { WeeklyReviewPanel } = await import("/src/weekly-review.ts");
    const data = { settings: { enabled: false }, model: "gpt-4.1-mini", available: true,
      week: { start: "2026-10-12", end: "2026-10-18", nextUpdate: "2026-10-26" }, status: "disabled", error: null, reviews: [] };
    let attempts = 0;
    const panel = new WeeklyReviewPanel({
      weeklyOverview: async () => structuredClone(data),
      previewReview: async () => { if (++attempts === 1) return { noData: true }; throw { message: "Preview limit reached. Allow 10 minutes between requests." }; },
    });
    window.enablePreviewFixture = async () => { data.settings.enabled = true; data.status = "no_data"; await panel.refresh(); };
    panel.element.id = "preview-fixture"; document.body.append(panel.element); await panel.refresh();
  });
  const panel = page.locator("#preview-fixture");
  await expect(panel.getByRole("button", { name: "Review this week so far" })).toHaveCount(0);
  await page.evaluate(() => window.enablePreviewFixture());
  await panel.getByRole("button", { name: "Review this week so far" }).click();
  await expect(panel).toContainText("No activity recorded this week yet. No AI request was made.");
  await panel.getByRole("button", { name: "Review this week so far" }).click();
  await expect(panel.getByRole("alert")).toContainText("Preview limit reached.");
  await expect(panel.locator(".weekly-preview")).toHaveCount(0);
});
