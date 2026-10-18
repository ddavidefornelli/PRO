// Opt-in smoke test against the CLI-managed LOCAL Docker stack, never a hosted project.
// Creates two disposable Auth users and deletes them (with cascaded planner data) on exit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localPublicConfig, localStatus } from "../../scripts/supabase-local.mjs";

const status = localStatus();
const config = localPublicConfig(status); // Loopback-only guard BEFORE using an admin key.
const url = config.PRO_SUPABASE_URL;
const publicKey = config.PRO_SUPABASE_ANON_KEY;
const serviceKey = status.SERVICE_ROLE_KEY;
if (typeof serviceKey !== "string" || !serviceKey) throw new Error("Local status did not include a service-role key for the smoke test.");

async function request(path, { key = publicKey, token = key === serviceKey ? key : undefined, method = "POST", body, ok = true } = {}) {
  const response = await fetch(`${url}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Do not log Auth response bodies: they can contain reusable credentials.
  if (!ok) return response;
  if (!response.ok) throw new Error(`Local ${path} failed (HTTP ${response.status}).`);
  return response.status === 204 ? null : response.json();
}

const users = [];
async function account() {
  const email = `pro-smoke-${randomUUID()}@example.test`;
  const user = await request("/auth/v1/admin/users", { key: serviceKey, body: { email, email_confirm: true } });
  if (typeof user.id !== "string") throw new Error("Local Auth did not create the fixture user.");
  users.push(user.id);
  // Admin generates a code locally; public /verify exercises the desktop's email-code API.
  // This intentionally does not test SMTP or send real email.
  const link = await request("/auth/v1/admin/generate_link", { key: serviceKey, body: { type: "magiclink", email } });
  if (typeof link.email_otp !== "string") throw new Error("Local Auth did not generate an email code.");
  const session = await request("/auth/v1/verify", { body: { type: "email", email, token: link.email_otp } });
  if (typeof session.access_token !== "string") throw new Error("Local Auth did not verify the email code.");
  return session.access_token;
}
const rpc = (token, action, args = {}, ok = true) => request("/rest/v1/rpc/planner_call", {
  token, ok, body: { p_action: action, p_args: args, p_timezone: "UTC" },
});

try {
  const alice = await account();
  const bob = await account();
  const dashboard = await rpc(alice, "dashboard");
  assert.equal(dashboard.todayTasks.length, 0);
  const task = await rpc(alice, "create_task", { outcome: "Docker backend smoke test", day: dashboard.today, estimatedMinutes: 15 });
  assert.equal((await rpc(alice, "dashboard")).todayTasks[0].id, task.id);
  assert.equal((await rpc(bob, "dashboard")).todayTasks.length, 0);
  const denied = await rpc(bob, "rename_task", { id: task.id, outcome: "Cross-account write" }, false);
  assert.equal(denied.ok, false);
  const rows = await request(`/rest/v1/planner_tasks?id=eq.${task.id}&select=id`, { token: bob, method: "GET" });
  assert.deepEqual(rows, []);
  const protocol = await rpc(alice, "queue_protocol");
  assert.equal(protocol.version, 1);
  console.log("Local Docker backend: email-code verification, migrations, planner RPC, queue protocol and account isolation passed.");
} finally {
  let cleanupFailed = false;
  for (const id of users) {
    try { await request(`/auth/v1/admin/users/${id}`, { key: serviceKey, method: "DELETE" }); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) {
    console.error("Could not remove all local smoke-test accounts. Inspect local Auth users in Studio.");
    process.exitCode = 1;
  }
}
