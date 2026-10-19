import { test as base, expect } from "@playwright/test";
import { ALICE, database } from "../helpers/database.mjs";

/** Real browser, real UI, real queue/storage/Web Locks, real migrated Postgres.
 * Only native IPC, email/session identity, file dialogs and remote availability are fixtures. */
export const test = base.extend({
  db: [async ({}, use) => {
    const db = await database();
    try { await use(db); } finally { await db.db.close(); }
  }, { scope: "worker" }],
  backend: async ({ db }, use) => {
    await db.reset();
    const state = {
      ...db, user: ALICE, signedIn: true, email: "user@example.com", offline: false, rejectWrites: false,
      protocolVersion: 1, protocolError: null, authError: null, signOutError: null, consentError: false, storageFull: false, calls: [],
    };
    state.invoke = async (command, args) => {
      state.calls.push({ command, args: structuredClone(args) });
      if (command === "auth_status") {
        if (state.authError) throw { code: "configuration", message: state.authError };
        return { configured: true, email: state.signedIn ? state.email : null, accountKey: state.signedIn ? `https://fixture.invalid:${state.user}` : null };
      }
      if (command === "request_sign_in_code") return null;
      if (command === "verify_sign_in_code") {
        if (args.code !== "12345678") throw { code: "auth", message: "Invalid code. Request a new code." };
        state.signedIn = true; return { configured: true, email: state.email };
      }
      if (command === "sign_out") {
        if (state.signOutError) throw { code: "credentials", message: state.signOutError };
        state.signedIn = false; return null;
      }
      if (command === "attach_task_file" || command === "open_task_resource" || command === "open_support_email") return null;
      if (command === "generate_weekly_review") throw { code: "ai", message: "Fixture AI unavailable. Your planner is unaffected." };
      if (command !== "planner_call") throw new Error(`Unexpected fixture command: ${command}`);
      if (state.offline) throw { code: "network", message: "Offline. Changes remain on this device." };
      if (args.action === "queue_protocol") {
        if (state.protocolError) throw state.protocolError;
        return { version: state.protocolVersion };
      }
      if (args.args._accountKey && args.args._accountKey !== `https://fixture.invalid:${state.user}`) throw { code: "account_changed", message: "The account changed. Reload before accessing planner data." };
      if (state.consentError && args.action === "set_weekly_ai_enabled") throw { code: "server", message: "Settings unavailable" };
      if (state.rejectWrites && args.args._requestId) throw { code: "validation", message: "Another device changed your plan." };
      try { return await db.call(args.action, args.args, state.user, args.timezone); }
      catch (error) { throw { code: error.code === "PT401" ? "unauthorized" : error.code?.startsWith("PT") ? "validation" : "server", message: error.code?.startsWith("PT") ? error.message : "Fixture SQL request failed" }; }
    };
    await use(state);
  },
  page: async ({ page, context, backend }, use) => {
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.exposeBinding("__fixtureInvoke", (_, command, args) => backend.invoke(command, args));
    await page.addInitScript(() => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__fixtureInvoke(command, args) };
    });
    await use(page);
    expect(external, "UI must not issue external network calls").toEqual([]);
    expect(errors, "No uncaught browser exceptions").toEqual([]);
  },
});
export { expect };
export async function open(page) {
  await page.goto("/");
  await expect(page.getByRole("navigation").getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".plan-date")).toBeVisible();
}
export async function add(page, outcome) {
  await page.getByRole("textbox", { name: "Outcome", exact: true }).fill(outcome);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByRole("button", { name: `Edit task title: ${outcome}`, exact: true })).toBeVisible();
}
export async function synced(page) {
  // A click does not await its async handler. First wait for the durable local
  // mutation/render, then its server acknowledgement, not a stale status label.
  await expect(page.locator("main [role=slider][aria-disabled=true], #focus-timer:disabled, .add-task:disabled, main .editable-title button:disabled")).toHaveCount(0);
  await expect.poll(() => pendingCount(page)).toBe(0);
}
export async function pendingCount(page) {
  return page.evaluate(async () => {
    const account = await window.__fixtureInvoke("auth_status", {});
    const saved = localStorage.getItem(`pro:planner:v1:${account.accountKey}`);
    return saved ? JSON.parse(saved).pending.length : -1;
  });
}
export async function reconnect(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}
