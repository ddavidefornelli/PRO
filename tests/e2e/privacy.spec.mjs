import { test, expect, add, synced } from "./fixtures.mjs";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../../src/privacy-state.ts";

test.use({ privacyAcknowledged: false });

const title = (page) => page.getByRole("heading", { name: "Privacy & agreements", exact: true });
const acknowledgement = (page) => page.getByRole("checkbox", { name: "I have read the Privacy Policy.", exact: true });
async function continueToApp(page) {
  await acknowledgement(page).check();
  await page.getByRole("button", { name: "Continue to prune", exact: true }).click();
}

test("first launch presents an unchecked notice before any account IPC or sign-in", async ({ page, backend }) => {
  backend.signedIn = false;
  await page.goto("/");
  await expect(title(page)).toBeVisible();
  await expect(acknowledgement(page)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Continue to prune" })).toBeDisabled();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  expect(backend.calls).toEqual([]);
  await page.getByRole("button", { name: "Read Privacy Policy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Privacy Policy", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Articles 13 and 14");
  await expect(dialog).toContainText("fornelli.dv@gmail.com");
  await expect(dialog).toContainText("International transfers");
  await expect(dialog).toContainText("normally within one month");
  await expect(dialog.locator("script, iframe, img")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Read Privacy Policy", exact: true })).toBeFocused();
  await expect(acknowledgement(page)).not.toBeChecked();
  expect(backend.calls).toEqual([]);
});

test("acknowledgement persists across reload and sign-in without enabling AI", async ({ page, backend }) => {
  backend.signedIn = false;
  await page.goto("/"); await continueToApp(page);
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
  const record = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PRIVACY_ACKNOWLEDGEMENT_KEY);
  expect(record.version).toBe(PRIVACY_POLICY_VERSION);
  expect(Number.isFinite(Date.parse(record.acknowledgedAt))).toBe(true);
  expect(Object.keys(record).sort()).toEqual(["acknowledgedAt", "version"]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
  await expect(title(page)).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await page.getByLabel("Digit 1 of 8").fill("12345678");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".plan-date")).toBeVisible();
  expect((await backend.call("weekly_overview")).settings.enabled).toBe(false);
  expect(backend.calls.filter((call) => call.command === "generate_weekly_review" || call.args?.action === "set_weekly_ai_enabled")).toEqual([]);
});

test("Not now and closing the policy never restore an account or save acknowledgement", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You have not continued" })).toBeVisible();
  await page.getByRole("button", { name: "Privacy Policy", exact: true }).click();
  await page.getByRole("button", { name: "Close privacy policy", exact: true }).click();
  expect(backend.calls).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), PRIVACY_ACKNOWLEDGEMENT_KEY)).toBeNull();
  await page.getByRole("button", { name: "Back to privacy notice", exact: true }).click();
  await expect(acknowledgement(page)).not.toBeChecked();
  await page.reload(); await expect(title(page)).toBeVisible();
  expect(backend.calls).toEqual([]);
});

test("a changed notice is presented again without clearing data or changing existing AI consent", async ({ page, backend }) => {
  await backend.create("Keep my plan");
  await backend.call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: "previous-policy", acknowledgedAt: "2026-01-01T00:00:00.000Z" }));
    localStorage.setItem("fixture:retained-data", "keep");
  }, PRIVACY_ACKNOWLEDGEMENT_KEY);
  await page.goto("/"); await expect(title(page)).toBeVisible();
  expect(backend.calls).toEqual([]);
  await continueToApp(page);
  await expect(page.getByRole("button", { name: "Edit task title: Keep my plan", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fixture:retained-data"))).toBe("keep");
  expect((await backend.call("weekly_overview")).settings.enabled).toBe(true);
  expect(backend.calls.filter((call) => call.args?.action === "set_weekly_ai_enabled")).toEqual([]);
  await page.reload(); await expect(page.locator(".plan-date")).toBeVisible();
  await expect(title(page)).toHaveCount(0);
});

test("a failed acknowledgement write stays at the gate and can be retried", async ({ page, backend }) => {
  await page.addInitScript((key) => {
    window.blockPrivacyWrite = true;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && window.blockPrivacyWrite) throw new DOMException("Full", "QuotaExceededError");
      return set.call(this, name, value);
    };
  }, PRIVACY_ACKNOWLEDGEMENT_KEY);
  await page.goto("/"); await continueToApp(page);
  await expect(page.getByRole("alert")).toContainText("Could not save your privacy acknowledgement");
  await expect(title(page)).toBeVisible();
  expect(backend.calls).toEqual([]);
  await page.evaluate(() => { window.blockPrivacyWrite = false; });
  await page.getByRole("button", { name: "Continue to prune" }).click();
  await expect(page.locator(".plan-date")).toBeVisible();
});

test("denied localStorage access is recoverable UI, not an auth bypass or uncaught error", async ({ page, backend }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Denied", "SecurityError"); } });
  });
  await page.goto("/"); await expect(title(page)).toBeVisible();
  await continueToApp(page);
  await expect(page.getByRole("alert")).toContainText("Allow app storage and try again");
  expect(backend.calls).toEqual([]);
  await page.getByRole("button", { name: "Read Privacy Policy", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("full privacy policy remains accessible during a running focus timer and after sign-out", async ({ page, backend }) => {
  await page.goto("/"); await continueToApp(page);
  await expect(page.locator(".plan-date")).toBeVisible();
  await add(page, "Keep focusing"); await synced(page);
  await page.getByRole("button", { name: "Start focus", exact: true }).click(); await synced(page);
  await expect(page.getByRole("button", { name: "Profile", exact: true })).toBeDisabled();
  await page.locator(".support-footer").getByRole("button", { name: "Privacy Policy", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("unencrypted app data");
  await page.keyboard.press("Escape");
  await expect(page.locator("#focus-timer")).not.toHaveClass(/is-paused/);
  await page.getByRole("button", { name: "Complete task", exact: true }).click(); await synced(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
  await page.getByRole("button", { name: "Privacy Policy", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(backend.signedIn).toBe(false);
});

for (const width of [320, 640, 1000]) {
  test(`privacy notice and scrollable policy fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 500 });
    await page.goto("/"); await expect(title(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width >= 640) {
      await expect(acknowledgement(page)).toBeInViewport();
      await expect(page.getByRole("button", { name: "Continue to prune" })).toBeInViewport({ ratio: 1 });
    }
    await page.getByRole("button", { name: "Read Privacy Policy", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(500);
    const content = dialog.getByRole("article");
    expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight && node.clientHeight > 0 && node.scrollWidth <= node.clientWidth)).toBe(true);
    const lastHeading = dialog.getByRole("heading", { name: "10. Local storage, children and changes to this notice" });
    await lastHeading.scrollIntoViewIfNeeded();
    await expect(lastHeading).toBeInViewport();
    await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(content.locator("p").last()).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Close privacy policy" })).toBeInViewport();
    await page.keyboard.press("Escape");
    await acknowledgement(page).check();
    await expect(page.getByRole("button", { name: "Continue to prune" })).toBeEnabled();
  });
}
