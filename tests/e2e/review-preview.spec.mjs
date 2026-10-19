import { test, expect, open } from "./fixtures.mjs";

async function mount(page, status = "up_to_date", enabled = true, available = true) {
  await open(page);
  await page.evaluate(async ({ status, enabled, available }) => {
    const { WeeklyReviewPanel } = await import("/src/weekly-review.ts");
    window.reviewGenerationCalls = 0;
    const panel = new WeeklyReviewPanel({
      weeklyOverview: async () => ({ settings: { enabled }, model: "test", available,
        week: { start: "2026-10-12", end: "2026-10-18", nextUpdate: "2026-10-25", nextUpdateAt: "2026-10-25T16:00:00Z" },
        status, error: status === "failed" ? "Service temporarily unavailable. Automatic retries are enabled." : null, reviews: [] }),
      previewReview: async () => { window.reviewGenerationCalls++; },
      retryWeeklyReview: async () => { window.reviewGenerationCalls++; },
    });
    panel.element.id = "countdown-fixture";
    const root = document.getElementById("app");
    root.classList.remove("single-screen");
    root.replaceChildren(panel.element);
    await panel.refresh();
    window.tickReview = (now) => panel.tick(now);
    panel.tick(Date.parse("2026-10-23T13:55:54Z"));
  }, { status, enabled, available });
  return page.locator("#countdown-fixture");
}

test("automatic review has a live countdown and no manual generation controls", async ({ page }) => {
  const panel = await mount(page);
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.locator(".review-countdown-value")).toHaveText(["02", "02", "04", "06"]);
  await expect(panel.getByRole("timer")).toHaveAttribute("aria-live", "off");
  await expect(panel.getByRole("heading", { name: "Next review" })).toBeVisible();
  await expect(panel.locator(".review-countdown-copy, .review-countdown-eyebrow, .review-countdown-footnote")).toHaveCount(0);
  await page.evaluate(() => window.tickReview(Date.parse("2026-10-23T13:55:55Z")));
  await expect(panel.locator(".review-countdown-value")).toHaveText(["02", "02", "04", "05"]);
  await page.evaluate(() => window.tickReview(Date.parse("2026-10-25T16:00:01Z")));
  await expect(panel.locator(".review-countdown-value")).toHaveText(["00", "00", "00", "00"]);
  await expect(panel).toContainText("Checking for your review…");
  expect(await page.evaluate(() => window.reviewGenerationCalls)).toBe(0);
});

for (const status of ["pending", "running", "failed", "unavailable"]) {
  test(`${status} reviews never offer generation or retry buttons`, async ({ page }) => {
    const panel = await mount(page, status, true, status !== "unavailable");
    await expect(panel.getByRole("button")).toHaveCount(0);
    if (status === "pending" || status === "running") {
      await expect(panel).toContainText("Preparing your review…");
      await expect(panel.getByRole("timer")).toHaveCount(0);
    }
    await expect(panel.getByRole("status")).toBeVisible();
  });
}

test("countdown waits for consent", async ({ page }) => {
  const panel = await mount(page, "disabled", false);
  await expect(panel.locator(".review-countdown")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Enable weekly AI reviews" })).toBeVisible();
  expect(await page.evaluate(() => window.reviewGenerationCalls)).toBe(0);
});

test("automatic generation respects consent, availability and due status", async ({ page }) => {
  await open(page);
  const results = await page.evaluate(async () => {
    const { PlanningClient } = await import("/src/api.ts");
    const results = [];
    for (const [enabled, available, status] of [[false, true, "pending"], [true, false, "pending"], [true, true, "up_to_date"], [true, true, "no_data"], [true, true, "running"], [true, true, "pending"], [true, true, "failed"]]) {
      const client = new PlanningClient();
      let calls = 0;
      client.weeklyOverview = async () => ({ settings: { enabled }, available, status });
      client.retryWeeklyReview = async () => { calls++; };
      await client.generateIfDue();
      results.push(calls);
    }
    return results;
  });
  expect(results).toEqual([0, 0, 0, 0, 0, 1, 1]);
});

test("automatic checks cannot overlap and recover after a failed request", async ({ page }) => {
  await open(page);
  const calls = await page.evaluate(async () => {
    const { PlanningClient } = await import("/src/api.ts");
    const client = new PlanningClient();
    let calls = 0;
    let release;
    client.weeklyOverview = async () => ({ settings: { enabled: true }, available: true, status: "pending" });
    client.retryWeeklyReview = () => { calls++; return new Promise((_, reject) => { release = () => reject(new Error("Offline")); }); };
    const first = client.generateIfDue().catch(() => {});
    await Promise.resolve();
    await client.generateIfDue();
    release();
    await first;
    client.retryWeeklyReview = async () => { calls++; };
    await client.generateIfDue();
    return calls;
  });
  expect(calls).toBe(2);
});

for (const width of [320, 390, 1000]) {
  test(`countdown fits at ${width}px with reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const panel = await mount(page);
    expect(await panel.locator(".review-countdown").evaluate((card) => card.scrollWidth <= card.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(panel.locator(".review-countdown-label")).toHaveText(["Days", "Hours", "Minutes", "Seconds"]);
  });
}
