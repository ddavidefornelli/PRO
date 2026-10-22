import { test, expect, open, add, synced } from "./fixtures.mjs";

const sizes = [
  { width: 640, height: 500 }, // Small desktop client area, excluding window chrome.
  { width: 640, height: 540 },
  { width: 800, height: 600 },
  { width: 1000, height: 760 },
  { width: 1440, height: 900 },
];
async function seed(backend, count) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const task = await backend.create(`${i + 1}. ${"A long, meaningful outcome with context. ".repeat(15)}`.slice(0, 500));
    tasks.push(task);
    await backend.db.query(`insert into public.planner_resources(user_id, task_id, label, target, kind)
      select '00000000-0000-4000-8000-000000000001', $1, repeat('Long reference ', 12) || s,
        'https://example.com/document/' || s, 'link' from generate_series(1, 50) s`, [task.id]);
  }
  return tasks;
}
async function fits(page) {
  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("main button:not(.task-crown), main input, main [role=slider], nav, .account-bar, .support-footer a")]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.getAttribute("aria-label") || node.textContent.slice(0, 40),
          top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
      });
    return { width: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth, controls };
  });
  expect(layout.scrollHeight, "document must not have vertically overflowing content").toBeLessThanOrEqual(layout.height + 1);
  expect(layout.scrollWidth, "document must not have horizontally overflowing content").toBeLessThanOrEqual(layout.width + 1);
  expect(layout.controls.filter((c) => c.top < -1 || c.bottom > layout.height + 1 || c.left < -1 || c.right > layout.width + 1 || c.width <= 0 || c.height <= 0), "controls must fit, not merely be clipped by overflow:hidden").toEqual([]);
  await page.mouse.wheel(0, 1000);
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

async function taskControlsAlign(page) {
  const rows = await page.locator(".task").evaluateAll((tasks) => tasks.map((task) => {
    const controls = [...task.querySelectorAll(".resource-form input, .resource-attach, .resource-count, .task-estimate .estimate-dial, :scope > button:not(.task-crown)")];
    const boxes = controls.map((node) => node.getBoundingClientRect());
    const card = task.getBoundingClientRect();
    return {
      aligned: boxes.every((box) => Math.abs(box.top - boxes[0].top) <= 1 && Math.abs(box.height - boxes[0].height) <= 1),
      contained: boxes.every((box) => box.width > 0 && box.left >= card.left && box.right <= card.right && box.bottom <= card.bottom),
      nonoverlapping: boxes.every((box, i) => i === 0 || box.left >= boxes[i - 1].right),
    };
  }));
  for (const row of rows) expect(row).toEqual({ aligned: true, contained: true, nonoverlapping: true });
}

async function centredInWindow(page) {
  await expect.poll(() => page.evaluate(() => {
    const navBottom = document.querySelector("nav").getBoundingClientRect().bottom;
    return [...document.querySelectorAll("#focus-timer")].map((node) => {
      const box = node.getBoundingClientRect();
      return { centred: Math.abs(box.top + box.height / 2 - innerHeight / 2) <= 1, clearOfHeader: box.top >= navBottom };
    });
  })).toEqual([{ centred: true, clearOfHeader: true }]);
  const headingOffset = await page.locator(".focus-details h1").evaluate((node) =>
    node.getBoundingClientRect().top - document.querySelector("main").getBoundingClientRect().top);
  const padding = await page.locator("main").evaluate((node) => parseFloat(getComputedStyle(node).paddingTop));
  expect(headingOffset).toBeCloseTo(padding, 0);
}

for (const size of sizes) {
  for (const count of [0, 1, 2, 3]) {
    test(`Today fits ${size.width}×${size.height} with ${count} long tasks and up to 50 resources each`, async ({ page, backend }) => {
      await page.setViewportSize(size); await seed(backend, count); await open(page);
      await expect(page.locator(".task-list .task")).toHaveCount(count);
      await fits(page);
      await taskControlsAlign(page);
      if (size.width === 640 && size.height === 500 && count === 3) {
        await page.screenshot({ path: test.info().outputPath("today-small-window.png") });
      }
      if (count < 3) await expect(page.getByRole("button", { name: "Add task", exact: true })).toBeVisible();
      if (count) {
        await expect(page.getByRole("button", { name: "Resources (50)", exact: true })).toHaveCount(count);
        await page.getByRole("button", { name: "Resources (50)", exact: true }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.getByRole("dialog").getByRole("button", { name: /^Link ·/ })).toHaveCount(50);
        await page.keyboard.press("Escape"); await fits(page);
      }
    });
  }
  for (const count of [0, 1, 2, 3]) {
    test(`Tomorrow fits ${size.width}×${size.height} with ${count} long tasks and up to 50 resources each`, async ({ page, backend }) => {
      await page.setViewportSize(size);
      const tasks = await seed(backend, count);
      await backend.db.query("update public.planner_tasks set planned_for = planned_for + 1 where id = any($1::uuid[])", [tasks.map((task) => task.id)]);
      await open(page);
      await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
      await expect(page.locator("#app")).toHaveClass(/single-screen/);
      await expect(page.locator(".task-list .task")).toHaveCount(count);
      await fits(page);
      await taskControlsAlign(page);
      if (count < 3) await expect(page.getByRole("button", { name: "Add task", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start focus", exact: true })).toHaveCount(0);
    });
  }
  test(`Focus, paused Focus and return to Today fit ${size.width}×${size.height}`, async ({ page, backend }) => {
    await page.setViewportSize(size);
    const tasks = await seed(backend, 3); await backend.call("start_task", { id: tasks[0].id });
    await page.goto("/"); await expect(page.locator("#focus-timer")).toBeVisible();
    await fits(page); await centredInWindow(page);
    if (size.width === 640 && size.height === 500) {
      await page.screenshot({ path: test.info().outputPath("focus-small-window.png") });
    }
    await page.locator("#focus-timer").click(); await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Taking a break");
    await page.getByRole("button", { name: "Save reason" }).click();
    await expect(page.locator("#focus-timer")).toHaveClass(/is-paused/);
    await fits(page); await centredInWindow(page);
    // Wide but short windows must also centre against the full viewport and
    // keep the timer below the navigation, not merely hide overflowing pixels.
    await page.setViewportSize({ width: 1440, height: 500 });
    await fits(page); await centredInWindow(page);
    await page.setViewportSize(size);
    await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("button", { name: "Return to focus" })).toBeVisible(); await fits(page);
  });
}

test("task controls stay aligned with zero, one or fifty resources and after resizing", async ({ page, backend }) => {
  const tasks = await seed(backend, 3);
  await backend.db.query("delete from public.planner_resources where task_id = $1", [tasks[0].id]);
  await backend.db.query("delete from public.planner_resources where task_id = $1 and target <> 'https://example.com/document/1'", [tasks[1].id]);
  await open(page);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await fits(page);
    await taskControlsAlign(page);
  }
  await backend.db.query("update public.planner_tasks set status = 'completed', completed_on = planned_for where id = any($1::uuid[])", [tasks.map((task) => task.id)]);
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await add(page, "Tomorrow's aligned task");
  await synced(page);
  await page.getByRole("textbox", { name: "Add a link; press Enter to save" }).fill("https://example.com/reference");
  await page.getByRole("textbox", { name: "Add a link; press Enter to save" }).press("Enter");
  await expect(page.getByRole("button", { name: "Resources (1)", exact: true })).toBeVisible();
  await synced(page);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await taskControlsAlign(page);
  }
});

test("Overview still scrolls, and returning to Today restores a single-screen layout", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 540 }); await open(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable weekly AI reviews" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 200));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click(); await fits(page);
});
