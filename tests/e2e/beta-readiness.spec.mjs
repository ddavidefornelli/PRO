import { test, expect, open, add, synced, pendingCount } from "./fixtures.mjs";

const writes = (backend) => backend.calls.filter((call) => call.command === "planner_call" && call.args.args._requestId);

// Ordinary input mistakes must not become durable, rejected queue entries.
test("blank task input stays editable without blocking later valid work", async ({ page, backend }) => {
  await open(page);
  const outcome = page.getByRole("textbox", { name: "Outcome", exact: true });
  await outcome.fill("   ");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(outcome).toHaveValue("   ");
  expect(await outcome.evaluate((input) => input.validity.valid)).toBe(false);
  expect(writes(backend)).toHaveLength(0);
  expect(await pendingCount(page)).toBe(0);
  await add(page, "A valid next step"); await synced(page);
  await expect(page.locator(".sync-bar")).toBeHidden();
});

for (const target of ["file:///tmp/notes.pdf", "javascript:alert(1)", "https://user:password@example.com/private"]) {
  test(`invalid resource ${target} is rejected before entering the outbox`, async ({ page, backend }) => {
    await open(page); await add(page, "Reference task"); await synced(page);
    const before = writes(backend).length;
    const link = page.getByRole("textbox", { name: "Add a link; press Enter to save" });
    await link.fill(target); await link.press("Enter");
    await expect(link).toHaveValue(target);
    expect(await link.evaluate((input) => input.validity.valid)).toBe(false);
    expect(writes(backend)).toHaveLength(before);
    expect(await pendingCount(page)).toBe(0);
    await expect(page.locator(".sync-bar")).toBeHidden();
    await link.fill("https://example.com/valid"); await link.press("Enter"); await synced(page);
    await expect(page.getByRole("button", { name: "Resources (1)", exact: true })).toBeVisible();
  });
}

for (const code of ["123456", "1234567", "123456789", "1234567890"]) {
  test(`${code.length}-digit email codes can sign in, not just eight-digit codes`, async ({ page, backend }) => {
    backend.signedIn = false;
    const invoke = backend.invoke;
    backend.invoke = async (command, args) => {
      if (command === "verify_sign_in_code") {
        backend.calls.push({ command, args: structuredClone(args) });
        if (args.code !== code) throw { code: "auth", message: "Wrong fixture code" };
        backend.signedIn = true;
        return { configured: true, email: backend.email };
      }
      return invoke(command, args);
    };
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill("user@example.com");
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await page.getByRole("group", { name: "Code from your email" }).getByRole("textbox").first().fill(code);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".plan-date")).toBeVisible();
    expect(backend.calls.find((call) => call.command === "verify_sign_in_code").args.code).toBe(code);
  });
}

test("AI settings failures are visible and recoverable from Profile", async ({ page, backend }) => {
  await open(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  backend.consentError = true;
  await page.getByRole("button", { name: "Enable weekly AI reviews", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not save AI settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable weekly AI reviews", exact: true })).toBeEnabled();
  expect(backend.calls.filter((call) => call.command === "generate_weekly_review")).toHaveLength(0);
  backend.consentError = false;
  await page.getByRole("button", { name: "Enable weekly AI reviews", exact: true }).click();
  await page.getByText("Review settings & privacy", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable weekly AI", exact: true })).toBeVisible();
});

test("keyboard focus is visible on the outcome field and estimate dial", async ({ page }) => {
  await open(page);
  const outcome = page.getByRole("textbox", { name: "Outcome", exact: true });
  await outcome.focus();
  for (const control of [outcome, page.getByRole("slider")]) {
    if (control !== outcome) await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-style", "solid");
    expect(await control.evaluate((node) => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
  }
});

test("malformed HTTP prefixes cannot pass browser URL validation and block the outbox", async ({ page, backend }) => {
  await open(page); await add(page, "Well-formed references"); await synced(page);
  const before = writes(backend).length;
  const link = page.getByRole("textbox", { name: "Add a link; press Enter to save" });
  for (const target of ["https:example.com", "https:/example.com", "https:\\example.com"]) {
    await link.fill(target); await link.press("Enter");
    await expect(link).toHaveValue(target);
    expect(await link.evaluate((input) => input.validity.valid)).toBe(false);
    expect(writes(backend)).toHaveLength(before);
    expect(await pendingCount(page)).toBe(0);
  }
  await link.fill("https://example.com/reference"); await link.press("Enter"); await synced(page);
  await expect(page.getByRole("button", { name: "Resources (1)", exact: true })).toBeVisible();
});

test("a Unicode link exceeding the database byte limit stays out of the queue", async ({ page, backend }) => {
  await open(page); await add(page, "Long reference"); await synced(page);
  const before = writes(backend).length;
  const link = page.getByRole("textbox", { name: "Add a link; press Enter to save" });
  const target = `https://example.com/${"語".repeat(3000)}`;
  await link.fill(target); await link.press("Enter");
  await expect(link).toHaveValue(target);
  expect(await link.evaluate((input) => input.validationMessage)).toContain("too long");
  expect(writes(backend)).toHaveLength(before);
  expect(await pendingCount(page)).toBe(0);
});

test("long codes can be typed digit by digit and resend restores the default boxes", async ({ page, backend }) => {
  backend.signedIn = false;
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const boxes = page.getByRole("group", { name: "Code from your email" }).getByRole("textbox");
  await boxes.first().pressSequentially("1234567890");
  await expect(boxes).toHaveCount(10);
  expect(await boxes.evaluateAll((inputs) => inputs.map((input) => input.value).join(""))).toBe("1234567890");
  await page.getByRole("button", { name: "Use another email / resend code" }).click();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(boxes).toHaveCount(8);
  await expect(boxes.first()).toHaveValue("");
  await boxes.first().pressSequentially("12345678");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".plan-date")).toBeVisible();
});

test("incomplete email codes do not reach Auth and are editable for retry", async ({ page, backend }) => {
  backend.signedIn = false;
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await page.getByLabel("Digit 1 of 8").fill("12345678");
  await page.getByLabel("Digit 4 of 8").fill("");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect(backend.calls.filter((call) => call.command === "verify_sign_in_code")).toHaveLength(0);
  await page.getByLabel("Digit 4 of 8").fill("4");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".plan-date")).toBeVisible();
});

test("initial AI settings loading failures can be retried from Profile", async ({ page, backend }) => {
  const invoke = backend.invoke;
  let unavailable = true;
  backend.invoke = (command, args) => {
    if (command === "planner_call" && args.action === "weekly_overview" && unavailable) {
      throw { code: "network", message: "Fixture unavailable" };
    }
    return invoke(command, args);
  };
  await open(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load your weekly review" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable weekly AI reviews", exact: true })).toBeVisible();
});

test("support mailto stays available across planner views and during a running timer", async ({ page, backend }) => {
  await page.setViewportSize({ width: 640, height: 500 });
  await open(page);
  const support = page.locator(".support-footer a");
  const nav = (name) => page.getByRole("navigation").getByRole("button", { name, exact: true });
  for (const view of ["Focus", "Overview", "Today"]) {
    await nav(view).click();
    await expect(support).toHaveAttribute("href", "mailto:fornelli.dv@gmail.com");
    await support.scrollIntoViewIfNeeded();
    await expect(support).toBeInViewport();
  }
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(support).toBeVisible();
  await nav("Today").click();
  await add(page, "Contact without losing focus"); await synced(page);
  await page.getByRole("button", { name: "Start focus", exact: true }).click(); await synced(page);
  await expect(support).toBeInViewport();
  const before = writes(backend).length;
  await support.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => backend.calls.filter((call) => call.command === "open_support_email").length).toBe(1);
  await expect(page.locator("#focus-timer")).not.toHaveClass(/is-paused/);
  expect(writes(backend)).toHaveLength(before);
  await page.getByRole("button", { name: "Complete task", exact: true }).click(); await synced(page);
  await nav("Tomorrow").click();
  await expect(support).toBeVisible();
});

test("support is usable even when authentication is misconfigured", async ({ page, backend }) => {
  backend.authError = "Configure the public Supabase project key.";
  await page.goto("/");
  const support = page.getByRole("link", { name: "fornelli.dv@gmail.com", exact: true });
  await expect(support).toHaveAttribute("href", "mailto:fornelli.dv@gmail.com");
  await support.click();
  await expect.poll(() => backend.calls.filter((call) => call.command === "open_support_email").length).toBe(1);
  await expect(page.getByRole("heading", { name: "Sign in to PRO" })).toBeVisible();
});

test("failed mail handler shows a copyable contact address without navigating away", async ({ page, backend }) => {
  const invoke = backend.invoke;
  backend.invoke = (command, args) => {
    if (command === "open_support_email") throw { code: "validation", message: "No email handler" };
    return invoke(command, args);
  };
  await open(page);
  const notice = page.waitForEvent("dialog");
  const clicked = page.getByRole("link", { name: "fornelli.dv@gmail.com", exact: true }).click();
  const dialog = await notice;
  expect(dialog.type()).toBe("alert");
  expect(dialog.message()).toContain("fornelli.dv@gmail.com");
  await dialog.accept(); await clicked;
  await expect(page.locator(".plan-date")).toBeVisible();
  await expect(page.getByRole("link", { name: "fornelli.dv@gmail.com", exact: true })).toHaveAttribute("href", "mailto:fornelli.dv@gmail.com");
});

test("browser preview exposes a normal mailto without needing desktop credentials", async ({ page }) => {
  await page.addInitScript(() => { window.isTauri = false; });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "fornelli.dv@gmail.com", exact: true })).toHaveAttribute("href", "mailto:fornelli.dv@gmail.com");
});
