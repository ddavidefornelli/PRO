import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../supabase/functions/weekly-review/domain.ts";
import { platformDependencies } from "../../supabase/functions/weekly-review/platform.ts";

const config = { url: "https://project.supabase.co/", publicKey: "public-project-key", serviceKey: "server-only-key", openAiKey: "openai-server-secret" };
const user = "00000000-0000-4000-8000-000000000001";

test("platform: verifies email sessions with Auth and returns only its verified user ID", async () => {
  const platform = platformDependencies(config, async (url, init) => {
    assert.equal(url, "https://project.supabase.co/auth/v1/user");
    assert.equal(init.headers.apikey, "public-project-key");
    assert.equal(init.headers.Authorization, "Bearer user-access-token");
    assert.equal(init.redirect, "error");
    return Response.json({ id: user, role: "authenticated", email: "user@example.com", is_anonymous: false });
  });
  assert.equal(await platform.authenticate("user-access-token"), user);
});

test("platform: public keys, forged tokens and unverified identities do not authenticate", async () => {
  for (const response of [
    new Response("sensitive Auth error", { status: 401 }),
    new Response("sensitive Auth error", { status: 403 }),
    Response.json({ id: user, role: "anon" }),
    Response.json({ id: user, role: "authenticated", email: "user@example.com", is_anonymous: true }),
    Response.json({ id: "not-a-user-uuid", role: "authenticated" }),
    Response.json({ role: "authenticated" }),
  ]) {
    const platform = platformDependencies(config, async () => response);
    await assert.rejects(() => platform.authenticate("forged-or-public-token"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
  }
});

test("platform: missing provider credentials fail closed without contacting Auth", async () => {
  let called = false;
  const platform = platformDependencies({ ...config, openAiKey: undefined }, async () => { called = true; return Response.json({}); });
  await assert.rejects(() => platform.authenticate("token"), (error) => error.status === 503);
  assert.equal(called, false);
});

test("platform: only server-to-server RPC receives the service key and verified identity", async () => {
  const platform = platformDependencies(config, async (url, init) => {
    assert.equal(url, "https://project.supabase.co/rest/v1/rpc/reserve_planner_review");
    assert.equal(init.headers.apikey, "server-only-key");
    assert.equal(init.headers.Authorization, "Bearer server-only-key");
    const args = JSON.parse(init.body);
    assert.equal(args.p_user_id, user);
    assert.equal(args.p_week_start, "2026-10-12");
    assert.equal(args.p_consent_version, "weekly-ai-v1");
    assert.equal(args.p_request_hash, "a".repeat(64));
    return Response.json({ outcome: "disabled" });
  });
  assert.deepEqual(await platform.reserve(user, { weekStart: "2026-10-12", consentVersion: "weekly-ai-v1" }, "a".repeat(64)), { outcome: "disabled" });
});

test("platform: authoritative activity is loaded only for the verified user", async () => {
  const platform = platformDependencies(config, async (url, init) => {
    assert.equal(url, "https://project.supabase.co/rest/v1/rpc/planner_review_input");
    assert.deepEqual(JSON.parse(init.body), { p_user_id: user, p_timezone: "Europe/Rome" });
    return Response.json({ disabled: true });
  });
  assert.deepEqual(await platform.loadInput(user, "Europe/Rome"), { disabled: true });
});

test("platform: upstream database errors never expose credentials or error payloads", async () => {
  const platform = platformDependencies(config, async () => new Response("database-password sensitive schema detail", { status: 500 }));
  await assert.rejects(() => platform.reserve(user, {}, "a".repeat(64)), (error) => {
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes("database-password"));
    assert.ok(!error.message.includes("server-only-key"));
    return true;
  });
});
