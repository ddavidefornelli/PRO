import { test, expect, open, add, synced, pendingCount, reconnect } from "./fixtures.mjs";

const nav = (page, name) => page.getByRole("navigation").getByRole("button", { name, exact: true });

test("browser-only preview refuses credentials outside the native runtime", async ({ page }) => {
  await page.addInitScript(() => { window.isTauri = false; });
  await page.goto("/"); await expect(page.getByText(/native runtime protects your session credentials/)).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("startup shows a visual status until authentication completes", async ({ page, backend }) => {
  const invoke = backend.invoke;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  backend.invoke = async (command, args) => {
    if (command === "auth_status") await waiting;
    return invoke(command, args);
  };
  await page.goto("/");
  const loading = page.getByRole("status", { name: "Loading PRO" });
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText("");
  await expect(page.locator(".support-footer a")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await expect(loading.locator(".startup-ring")).toHaveCSS("animation-name", "startup-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(loading.locator(".startup-ring")).toHaveCSS("animation-name", "none");
  release();
  await expect(loading).toHaveCount(0);
  await expect(nav(page, "Today")).toHaveAttribute("aria-current", "page");
});

test("a stalled native login stops spinning and can complete late", async ({ page, backend }) => {
  const invoke = backend.invoke;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  backend.invoke = async (command, args) => {
    if (command === "auth_status") await waiting;
    return invoke(command, args);
  };
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".startup-ring")).toBeVisible();
  await page.clock.fastForward(30_001);
  await expect(page.locator(".startup-ring")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Startup is taking longer than expected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  release();
  await expect(nav(page, "Today")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Startup is taking longer than expected")).toHaveCount(0);
});

test("email-code workflow handles invalid code, resend and successful authentication", async ({ page, backend }) => {
  backend.signedIn = false;
  await page.goto("/");
  await expect(page.locator(".error:visible")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("group", { name: "Code from your email" }).getByRole("textbox")).toHaveCount(8);
  await page.getByLabel("Digit 1 of 8").fill("99999999"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid code");
  await page.getByRole("button", { name: "Use another email / resend code" }).click();
  await expect(page.getByRole("group", { name: "Code from your email" })).toBeHidden();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByLabel("Digit 1 of 8")).toHaveValue("");
  await page.getByLabel("Digit 1 of 8").pressSequentially("12");
  await expect(page.getByLabel("Digit 3 of 8")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(page.getByLabel("Digit 2 of 8")).toBeFocused();
  await expect(page.getByLabel("Digit 2 of 8")).toHaveValue("");
  // Pasting a complete code into any square replaces the whole code.
  await page.getByLabel("Digit 2 of 8").evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "1234 5678");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
  });
  for (let i = 0; i < 8; i++) await expect(page.getByLabel(`Digit ${i + 1} of 8`)).toHaveValue(String(i + 1));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(nav(page, "Today")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".plan-date")).toBeVisible();
});

test("configuration failures surface a recoverable authentication error", async ({ page, backend }) => {
  backend.authError = "Configure the public Supabase project key.";
  await page.goto("/"); await expect(page.getByRole("alert")).toContainText(backend.authError);
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
});

test("full day: three tasks, crown priority, timer/pause reason, completion, tomorrow, calendar", async ({ page, backend }) => {
  await open(page); await expect(nav(page, "Tomorrow")).toHaveCount(0);
  await add(page, "Write proposal"); await add(page, "Review draft"); await add(page, "Send proposal"); await synced(page);
  await expect(page.getByRole("button", { name: "Add task", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start focus" }).nth(1)).toBeDisabled();
  await page.getByRole("button", { name: "Make most important task" }).last().click(); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).last().click();
  await expect(nav(page, "Today")).toBeDisabled(); await expect(nav(page, "Overview")).toBeDisabled();
  await page.locator("#focus-timer").click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Lunch and a walk");
  await page.getByRole("button", { name: "Save reason" }).click();
  await expect(page.locator("#focus-timer")).toHaveClass(/is-paused/);
  await page.locator("#focus-timer").click(); await page.getByRole("button", { name: "Complete task" }).click(); await synced(page);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Start focus" }).first().click();
    await page.getByRole("button", { name: "Complete task" }).click(); await synced(page);
  }
  await expect(nav(page, "Focus")).toHaveCount(0); await nav(page, "Tomorrow").click();
  await add(page, "Tomorrow's next step"); await synced(page);
  await expect(page.getByRole("button", { name: "Start focus" })).toHaveCount(0);
  await nav(page, "Overview").click();
  await expect(page.getByRole("heading", { name: /3 tasks completed in/ })).toBeVisible();
  expect((await backend.call("dashboard")).completions).toEqual([{ day: backend.dates.today, count: 3 }]);
  expect((await backend.db.query("select reason from public.planner_stops")).rows[0].reason).toBe("Lunch and a walk");
});

test("Focus notes are a temporary scratchpad, not saved task data", async ({ page, backend }) => {
  await open(page); await add(page, "Scratchpad task"); await add(page, "Next task"); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).first().click(); await synced(page);
  const callsBefore = backend.calls.length;
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await notes.fill("Private temporary thoughts");
  expect(backend.calls.length).toBe(callsBefore);
  await page.locator("#focus-timer").click();
  await expect(page.getByRole("textbox", { name: "Why are you stopping?" })).toBeFocused();
  await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Break");
  await page.getByRole("button", { name: "Save reason" }).click();
  await expect(notes).toHaveValue("Private temporary thoughts");
  await nav(page, "Today").click();
  await page.getByRole("button", { name: "Return to focus" }).click();
  await expect(notes).toHaveValue("Private temporary thoughts");
  await synced(page);
  await page.reload();
  await nav(page, "Focus").click();
  await expect(notes).toHaveValue("");
  await notes.fill("Clear on completion");
  await page.getByRole("button", { name: "Complete task" }).click(); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).click();
  await expect(notes).toHaveValue("");
});

test("started tasks are editable only in Focus, including while paused", async ({ page }) => {
  await open(page); await add(page, "Focus-only edits"); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).click();
  await page.getByRole("button", { name: "Edit task title: Focus-only edits", exact: true }).click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill("Updated in Focus");
  await page.getByRole("textbox", { name: "Task title", exact: true }).press("Enter"); await synced(page);
  await page.getByLabel("Add a link; press Enter to save").fill("https://example.com/reference");
  await page.keyboard.press("Enter"); await synced(page);
  await page.locator("#focus-timer").click();
  await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Checking my plan");
  await page.getByRole("button", { name: "Save reason" }).click();
  await nav(page, "Today").click();
  await expect(page.getByRole("heading", { name: "Updated in Focus", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit task title:/ })).toHaveCount(0);
  await expect(page.getByLabel("Add a link; press Enter to save")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach file", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resources (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: /Link ·/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Remove .* from task/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close resources" }).click();
  await page.getByRole("button", { name: "Return to focus" }).click();
  await expect(page.getByRole("button", { name: "Edit task title: Updated in Focus", exact: true })).toBeVisible();
  await expect(page.getByLabel("Add a link; press Enter to save")).toBeVisible();
  await page.getByRole("button", { name: "Resources (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: /Remove .* from task/ })).toBeVisible();
});

test("pause reason survives Escape and resizing out of a fullscreen-sized window", async ({ page, backend }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page); await add(page, "Keep my stop reason"); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).click();
  await page.locator("#focus-timer").click();
  const dialog = page.getByRole("dialog");
  const reason = page.getByRole("textbox", { name: "Why are you stopping?" });
  await reason.fill("Taking a break after leaving fullscreen");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  for (const size of [{ width: 800, height: 600 }, { width: 390, height: 500 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog).toBeVisible();
    await expect(reason).toBeInViewport();
    await expect(reason).toHaveValue("Taking a break after leaving fullscreen");
    await expect(page.getByRole("button", { name: "Save reason" })).toBeInViewport();
  }
  await page.getByRole("button", { name: "Save reason" }).click();
  await expect(dialog).toHaveCount(0);
  await synced(page);
  expect((await backend.db.query("select reason from public.planner_stops")).rows[0].reason)
    .toBe("Taking a break after leaving fullscreen");
});

test("offline pause and completion survive browser restart and replay through real SQL", async ({ page, backend }) => {
  await open(page); await add(page, "Reliable work"); await synced(page);
  await page.getByRole("button", { name: "Start focus" }).click(); await synced(page);
  backend.offline = true;
  await page.locator("#focus-timer").click(); await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Network outage break");
  await page.getByRole("button", { name: "Save reason" }).click();
  await page.getByRole("button", { name: "Complete task" }).click();
  await expect(nav(page, "Tomorrow")).toBeVisible();
  await expect.poll(() => pendingCount(page)).toBe(3);
  await expect(page.locator(".sync-bar")).toBeHidden();
  await page.reload(); await expect(nav(page, "Tomorrow")).toBeVisible();
  backend.offline = false;
  await reconnect(page); await synced(page);
  const data = await backend.call("dashboard"); expect(data.todayTasks[0].status).toBe("completed");
  expect((await backend.db.query("select reason from public.planner_stops")).rows[0].reason).toBe("Network outage break");
});

test("rejected optimistic work is retained until explicit discard and cannot overwrite the server", async ({ page, backend }) => {
  await open(page); backend.rejectWrites = true;
  await add(page, "Rejected outcome"); await expect(page.locator(".sync-bar")).toContainText("Some recent changes could not be applied");
  expect((await backend.call("dashboard")).todayTasks).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard rejected changes" }).click(); await synced(page);
  await expect(page.getByRole("button", { name: "Edit task title: Rejected outcome" })).toHaveCount(0);
});

test("unsupported queue protocol never sends a retryable mutation", async ({ page, backend }) => {
  backend.protocolVersion = 0; await open(page); await add(page, "Retain without unsafe upload");
  await expect.poll(() => pendingCount(page)).toBe(1);
  await expect(page.locator(".sync-bar")).toBeHidden();
  expect(backend.calls.filter((c) => c.command === "planner_call" && c.args.args._requestId)).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Discard rejected changes" })).toBeHidden();
});

for (const code of ["network", "server"]) {
  test(`queue protocol ${code} failure stays invisible and automatically retries the same pending change`, async ({ page, backend }) => {
    backend.protocolError = { code, message: `${code} fixture: Supabase is temporarily unreachable.` };
    await open(page); await add(page, "Keep my pending change");
    await expect.poll(() => pendingCount(page)).toBe(1);
    await expect(page.locator(".sync-bar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Discard rejected changes" })).toBeHidden();
    expect(backend.calls.filter((c) => c.command === "planner_call" && c.args.args._requestId)).toHaveLength(0);
    backend.protocolError = null;
    await reconnect(page); await synced(page);
    expect((await backend.call("dashboard")).todayTasks).toHaveLength(1);
  });
}

test("old dispatcher rejection retains the outbox without exposing routine sync controls", async ({ page, backend }) => {
  backend.protocolError = { code: "validation", message: "Unsupported planner command." };
  await open(page); await add(page, "Wait for backend upgrade");
  await expect.poll(() => pendingCount(page)).toBe(1);
  await expect(page.locator(".sync-bar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Discard rejected changes" })).toBeHidden();
  backend.protocolError = null;
  await reconnect(page); await synced(page);
  expect((await backend.call("dashboard")).todayTasks[0].outcome).toBe("Wait for backend upgrade");
});

test("localStorage exhaustion rejects the action, preserves typed input and sends nothing", async ({ page, backend }) => {
  await open(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Disk full", "QuotaExceededError"); }; });
  await page.getByRole("textbox", { name: "Outcome", exact: true }).fill("Do not lose this draft");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Outcome", exact: true })).toHaveValue("Do not lose this draft");
  await expect(page.locator("p.error").filter({ hasText: "Disk full" })).toBeVisible();
  expect(backend.calls.filter((c) => c.command === "planner_call" && c.args.args._requestId)).toHaveLength(0);
});

test("periodic/focus refresh never destroys an in-progress new-task draft", async ({ page, backend }) => {
  await open(page);
  const draft = page.getByRole("textbox", { name: "Outcome", exact: true }); await draft.fill("Unsubmitted important draft");
  await backend.create("A cross-device addition");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(draft).toHaveValue("Unsubmitted important draft");
  await draft.evaluate((input) => input.blur());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Edit task title: A cross-device addition", exact: true })).toBeVisible();
});

test("title editing supports Escape cancellation and Enter commit without HTML execution", async ({ page }) => {
  await open(page); await add(page, "Original"); await synced(page);
  await page.getByRole("button", { name: "Edit task title: Original", exact: true }).click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill("Cancelled"); await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit task title: Original", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit task title: Original", exact: true }).click();
  const payload = "<img src=https://attacker.invalid/x onerror=alert(1)>";
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill(payload); await page.keyboard.press("Enter"); await synced(page);
  await expect(page.getByRole("button", { name: `Edit task title: ${payload}`, exact: true })).toBeVisible(); await expect(page.locator("img")).toHaveCount(0);
});

test("resources add/remove with stable IDs, and file/open actions are blocked while offline work is pending", async ({ page, backend }) => {
  await open(page); await add(page, "References"); await synced(page);
  await page.getByLabel("Add a link; press Enter to save").fill("https://example.com/reference?q=1"); await page.keyboard.press("Enter"); await synced(page);
  await page.getByRole("button", { name: "Resources (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Link · example.com/reference" })).toBeVisible();
  await page.getByRole("button", { name: "Close resources" }).click();
  backend.offline = true;
  await page.getByRole("button", { name: "Edit task title: References", exact: true }).click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill("References offline"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Resources (1)", exact: true }).click();
  await page.getByRole("button", { name: "Link · example.com/reference" }).click();
  await expect(page.locator("p.error").filter({ hasText: "Sync pending" })).toBeVisible();
  await page.getByRole("button", { name: "Close resources" }).click();
  expect(backend.calls.filter((c) => c.command === "open_task_resource")).toHaveLength(0);
  backend.offline = false; await reconnect(page); await synced(page);
  await page.getByRole("button", { name: "Resources (1)", exact: true }).click();
  await page.getByRole("button", { name: "Remove example.com/reference from task" }).click(); await synced(page);
  await expect(page.getByRole("button", { name: "Link · example.com/reference" })).toHaveCount(0);
});

test("estimate dial has keyboard bounds and commits only changed estimates", async ({ page, backend }) => {
  await open(page); await add(page, "Keyboard estimates"); await synced(page);
  const dial = page.getByRole("slider").first(); await dial.focus(); await page.keyboard.press("End"); await synced(page);
  await expect(dial).toHaveAttribute("aria-valuenow", "60");
  await expect(dial).not.toHaveAttribute("aria-disabled", "true");
  await dial.focus(); await page.keyboard.press("Home"); await synced(page); await expect(dial).toHaveAttribute("aria-valuenow", "5");
  await expect(dial).not.toHaveAttribute("aria-disabled", "true");
  await dial.focus(); await page.keyboard.press("ArrowDown");
  expect((await backend.call("dashboard")).todayTasks[0].estimatedMinutes).toBe(5);
});

test("calendar has one tab stop, arrow layout navigation, and no focusable future dates", async ({ page }) => {
  await open(page); await nav(page, "Overview").click();
  const cells = page.locator(".activity-grid [role=listitem]");
  await expect(cells).toHaveCount(new Date().getUTCFullYear() % 4 === 0 ? 366 : 365);
  const selected = page.locator(".activity-grid [tabindex='0']"); await expect(selected).toHaveCount(1);
  await selected.focus(); await page.keyboard.press("Home"); await expect(page.locator(".activity-grid [tabindex='0']")).toHaveAttribute("aria-label", /January 1,/);
  await page.keyboard.press("ArrowRight"); await expect(page.locator(".activity-grid [tabindex='0']")).toHaveAttribute("aria-label", /January 8,/);
  await expect(page.locator(".activity-grid .is-future[tabindex]")).toHaveCount(0);
});

test("AI enable failure does not trigger generation and never interrupts core planning", async ({ page, backend }) => {
  backend.consentError = true; await open(page); await nav(page, "Overview").click();
  await page.getByRole("button", { name: "Enable weekly AI reviews" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not save AI settings" })).toBeVisible();
  expect(backend.calls.filter((c) => c.command === "generate_weekly_review")).toHaveLength(0);
  await nav(page, "Today").click(); await add(page, "Planner unaffected"); await synced(page);
});

test("sign-out warns about pending work, cancel keeps the account, and re-sign-in restores the same outbox", async ({ page, backend }) => {
  await open(page); backend.offline = true; await add(page, "Keep pending through sign-out");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.locator(".profile-footer button")).toHaveAccessibleName("Sign out");
  page.once("dialog", (dialog) => dialog.dismiss()); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  expect(backend.signedIn).toBe(true);
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to PRO" })).toBeVisible();
  backend.signedIn = true; backend.offline = false; await page.reload(); await synced(page);
  await expect(page.getByRole("button", { name: "Edit task title: Keep pending through sign-out", exact: true })).toBeVisible();
  expect((await backend.call("dashboard")).todayTasks).toHaveLength(1);
});

test("switching immutable accounts hides prior data and preserves each account's private outbox", async ({ page, backend }) => {
  await open(page); await add(page, "Alice synced work"); await synced(page);
  backend.offline = true; await add(page, "Alice private pending work");
  backend.user = "00000000-0000-4000-8000-000000000002"; backend.email = "bob@example.com"; backend.offline = false;
  await page.reload(); await expect(nav(page, "Today")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".plan-date")).toBeVisible();
  await expect(page.locator(".task-list .task")).toHaveCount(0);
  await add(page, "Bob private work"); await synced(page);
  backend.user = "00000000-0000-4000-8000-000000000001"; backend.email = "user@example.com";
  await page.reload(); await expect(page.getByRole("button", { name: "Edit task title: Alice private pending work", exact: true })).toBeVisible(); await synced(page);
  await expect(page.getByRole("button", { name: "Edit task title: Bob private work", exact: true })).toHaveCount(0);
  expect((await backend.call("dashboard")).todayTasks).toHaveLength(2);
});

test("two real browser windows share Web Locks and localStorage without duplicate or lost writes", async ({ page, context, backend }) => {
  await open(page);
  const second = await context.newPage();
  const errors = []; second.on("pageerror", (error) => errors.push(error.message));
  await second.exposeBinding("__fixtureInvoke", (_, command, args) => backend.invoke(command, args));
  await second.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__fixtureInvoke(command, args) };
  });
  try {
    await open(second); backend.offline = true;
    await Promise.all([add(page, "First window's outcome"), add(second, "Second window's outcome")]);
    const key = "pro:planner:v1:https://fixture.invalid:00000000-0000-4000-8000-000000000001";
    await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).pending.length, key)).toBe(2);
    backend.offline = false;
    await Promise.all([reconnect(page), reconnect(second)]);
    await Promise.all([synced(page), synced(second)]);
    const tasks = (await backend.call("dashboard")).todayTasks;
    expect(tasks.map((task) => task.outcome).sort()).toEqual(["First window's outcome", "Second window's outcome"]);
    expect((await backend.db.query("select count(*)::int n from public.planner_receipts")).rows[0].n).toBe(2);
    expect(errors).toEqual([]);
  } finally { await second.close(); }
});

test("fresh account has no tomorrow view, no completions, and AI disabled by default", async ({ page }) => {
  await open(page);
  await expect(page.locator(".error:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await expect(page.getByText("All changes synced", { exact: true })).toHaveCount(0);
  await expect(page.locator(".sync-bar")).toBeHidden();
  await expect(page.locator(".task-list .task")).toHaveCount(0);
  await nav(page, "Focus").click(); await expect(page.getByText("Choose a task from Today to begin.")).toBeVisible();
  await nav(page, "Overview").click(); await expect(page.getByRole("heading", { name: /0 tasks completed in/ })).toBeVisible();
  await expect(page.getByText("Weekly AI is off. Enable it above to receive a weekly reflection.")).toBeVisible();
});
