import { test, expect, open, add, synced } from "./fixtures.mjs";

const profile = (page) => page.getByRole("button", { name: "Profile", exact: true });
const signOut = (page) => page.getByRole("button", { name: "Sign out", exact: true });
const stat = (page, name) => page.locator(".profile-stat").filter({ has: page.getByText(name, { exact: true }) }).locator("dd");
const nav = (page, name) => page.getByRole("navigation").getByRole("button", { name, exact: true });

test("profile shows stats with a red sign-out button at the bottom and no page tabs or extra copy", async ({ page, backend }) => {
  await open(page);
  await expect(signOut(page)).toHaveCount(0);
  await profile(page).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All time", exact: true })).toBeVisible();
  await expect(page.locator(".profile-heading .profile-email")).toHaveText("user@example.com");
  await expect(profile(page)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("nav [aria-current]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stats", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Logout", exact: true })).toHaveCount(0);
  await expect(page.getByText("Your progress across all saved completion history.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".profile-note, .logout-card")).toHaveCount(0);
  await expect(stat(page, "Tasks completed")).toHaveText("0");
  await expect(stat(page, "Current streak")).toHaveText("0 days");
  await expect(stat(page, "Today’s task focus")).toHaveText("0m");
  await expect(page.locator(".profile-page > :last-child button")).toHaveAccessibleName("Sign out");
  await expect(signOut(page)).toHaveCSS("background-color", "rgb(217, 45, 38)");
  const position = await page.locator(".profile-page").evaluate((node) => ({
    footer: node.querySelector(".profile-footer").getBoundingClientRect().top,
    calendar: node.querySelector(".activity-calendar").getBoundingClientRect().bottom,
  }));
  expect(position.footer).toBeGreaterThan(position.calendar);
  expect(backend.signedIn).toBe(true);
  expect(backend.calls.filter((call) => call.command === "sign_out")).toHaveLength(0);
  await nav(page, "Today").click();
  await expect(profile(page)).not.toHaveAttribute("aria-current", "page");
  await expect(signOut(page)).toHaveCount(0);
  await profile(page).click(); await signOut(page).click();
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
  expect(backend.calls.filter((call) => call.command === "sign_out")).toHaveLength(1);
});

test("profile stats use real account history and today's tracked time without leaking another user's data", async ({ page, backend }) => {
  await backend.db.query(`insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, actual_seconds, status, completed_on)
    values ('00000000-0000-4000-8000-000000000001', 'Historical outcome', $1::date - 1, 1, 30, 600, 'completed', $1::date - 1),
      ('00000000-0000-4000-8000-000000000002', 'Private other account', $1::date - 1, 1, 30, 5000, 'completed', $1::date - 1)`, [backend.dates.today]);
  const task = await backend.create("Today's completed outcome");
  await backend.call("start_task", { id: task.id });
  await backend.call("complete_task", { id: task.id });
  await backend.db.query("update public.planner_tasks set actual_seconds = 3660 where id = $1", [task.id]);
  await open(page); await profile(page).click();
  await expect(stat(page, "Tasks completed")).toHaveText("2");
  await expect(stat(page, "Active days")).toHaveText("2");
  await expect(stat(page, "Current streak")).toHaveText("2 days");
  await expect(stat(page, "Best streak")).toHaveText("2 days");
  await expect(stat(page, "Completed today")).toHaveText("1");
  await expect(stat(page, "Today’s task focus")).toHaveText("1h 1m");
  await expect(page.getByText("Today’s plan: 1/1 complete · 30m estimated", { exact: true })).toBeVisible();
});

test("profile is focus-locked while running and reflects local completions before sync", async ({ page, backend }) => {
  await open(page); await add(page, "Offline progress"); await synced(page);
  backend.offline = true;
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(profile(page)).toBeDisabled();
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(profile(page)).toBeEnabled();
  await profile(page).click();
  await expect(stat(page, "Tasks completed")).toHaveText("1");
  await expect(stat(page, "Completed today")).toHaveText("1");
  await expect(stat(page, "Current streak")).toHaveText("1 day");
});

test("failed sign-out stays recoverable on the profile and resumes the planner queue", async ({ page, backend }) => {
  await open(page); await profile(page).click();
  backend.signOutError = "Could not access the OS credential store. Unlock it and try again.";
  await signOut(page).click();
  await expect(page.getByRole("alert").filter({ hasText: backend.signOutError })).toBeInViewport();
  await expect(signOut(page)).toBeEnabled();
  expect(backend.signedIn).toBe(true);
  await nav(page, "Today").click(); await add(page, "Still able to save"); await synced(page);
  expect((await backend.call("dashboard")).todayTasks[0].outcome).toBe("Still able to save");
  backend.signOutError = null;
  await profile(page).click(); await signOut(page).click();
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
});

test("profile sign-out remains accessible if the planner cannot load", async ({ page, backend }) => {
  backend.offline = true;
  await page.goto("/");
  await expect(profile(page)).toBeVisible(); await profile(page).click();
  await expect(page.getByText("Stats unavailable.", { exact: true })).toBeVisible();
  await signOut(page).click();
  await expect(page.getByRole("heading", { name: "Sign in to prune" })).toBeVisible();
});

for (const size of [{ width: 390, height: 500 }, { width: 640, height: 500 }, { width: 1000, height: 760 }]) {
  test(`profile keeps the email at the right and fits ${size.width}×${size.height} with a long address`, async ({ page, backend }) => {
    backend.email = `${"long-address-".repeat(8)}@example.com`;
    await page.setViewportSize(size); await open(page); await profile(page).click();
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    const header = await page.locator(".profile-heading").evaluate((node) => ({
      right: node.getBoundingClientRect().right,
      email: node.querySelector(".profile-email").getBoundingClientRect().toJSON(),
      title: node.querySelector("h1").getBoundingClientRect().toJSON(),
    }));
    expect(header.email.right).toBeCloseTo(header.right, 0);
    expect(header.email.left).toBeGreaterThan(header.title.right);
    await expect(page.locator(".profile-email")).toHaveCSS("text-align", "right");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await signOut(page).scrollIntoViewIfNeeded();
    await expect(signOut(page)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await nav(page, "Today").click();
    await expect(page.locator("#app")).toHaveClass(/single-screen/);
    await expect(profile(page)).toBeInViewport();
  });
}
