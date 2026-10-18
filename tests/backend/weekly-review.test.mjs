import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, fingerprint, validateInput, validateAnalysis } from "../../supabase/functions/weekly-review/domain.ts";
import { createHandler } from "../../supabase/functions/weekly-review/handler.ts";
import { generateReview, providerBody, readLimited } from "../../supabase/functions/weekly-review/provider.ts";

const now = new Date("2026-10-19T12:00:00Z");
function input() {
  return {
    consentVersion: "weekly-ai-v1", weekStart: "2026-10-12", weekEnd: "2026-10-18",
    activity: {
      tasks: [{ id: "task-1", outcome: "Finish proposal", plannedFor: "2026-10-12", completedOn: "2026-10-13", status: "completed", estimatedMinutes: 30, actualSeconds: 1800 }],
      stops: [{ id: 1, taskId: "task-1", reason: "Lunch", stoppedOn: "2026-10-12" }], totalStops: 1, omittedStops: 0,
    },
  };
}
const analysis = { summary: "One task was completed.", mainReasons: [{ reason: "A lunch break was recorded.", evidenceStopIds: [1] }], improvements: ["Continue recording your reasons for stopping."] };
function setup(overrides = {}) {
  const calls = { auth: 0, reserve: 0, generate: 0, finish: 0, fail: 0 };
  const deps = {
    authenticate: async () => { calls.auth++; return "verified-user"; },
    loadInput: async (id, timezone) => { assert.equal(id, "verified-user"); assert.equal(timezone, "UTC"); return input(); },
    reserve: async (id) => { assert.equal(id, "verified-user"); calls.reserve++; return { outcome: "reserved", id: "request", leaseToken: "lease" }; },
    generate: async () => { calls.generate++; return analysis; },
    finish: async () => { calls.finish++; return true; },
    fail: async () => { calls.fail++; },
    now: () => now, allowedOrigins: new Set(["tauri://localhost"]), ...overrides,
  };
  return { handler: createHandler(deps), calls };
}
function request(body = { timezone: "UTC" }, headers = {}) {
  return new Request("https://example.supabase.co/functions/v1/weekly-review", {
    method: "POST", headers: { Authorization: "Bearer session-token", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("validates existing Rust activity shape and normalizes retry hashes", async () => {
  assert.deepEqual(validateInput(input(), now), input());
  const original = input();
  original.activity.tasks.push({ ...original.activity.tasks[0], id: "another-task" });
  const reordered = structuredClone(original);
  reordered.activity.tasks.reverse();
  assert.equal(await fingerprint(validateInput(original, now)), await fingerprint(validateInput(reordered, now)));
});

test("rejects extra fields, resources, malformed dates, unbounded text and invented stop references", () => {
  const invalid = [];
  const mutate = (change) => { const value = input(); change(value); invalid.push(value); };
  mutate((v) => { v.userId = "someone-else"; });
  mutate((v) => { v.model = "expensive-model"; });
  mutate((v) => { v.activity.tasks[0].resources = [{ target: "/private/file" }]; });
  mutate((v) => { v.weekStart = "2026-02-30"; });
  mutate((v) => { v.weekStart = "2026-10-19"; v.weekEnd = "2026-10-25"; });
  mutate((v) => { v.activity.stops[0].taskId = "unknown"; });
  mutate((v) => { v.activity.stops[0].stoppedOn = "2026-10-11"; });
  mutate((v) => { v.activity.stops[0].reason = "x".repeat(1001); });
  mutate((v) => { v.activity.stops.push(v.activity.stops[0]); v.activity.totalStops = 2; });
  mutate((v) => { v.activity.totalStops = 2; });
  mutate((v) => { v.activity.tasks[0].completedOn = null; });
  mutate((v) => { v.consentVersion = "old"; });
  mutate((v) => {
    v.activity.stops = Array.from({ length: 17 }, (_, i) => ({ ...v.activity.stops[0], id: i + 1, reason: "x".repeat(1000) }));
    v.activity.totalStops = 17;
  });
  for (const value of invalid) assert.throws(() => validateInput(value, now), ApiError);
});

test("accepts local week boundaries and older task context, but no arbitrary backfill", () => {
  const value = input();
  value.activity.tasks[0].plannedFor = "2026-09-01";
  value.activity.tasks[0].completedOn = null;
  value.activity.tasks[0].status = "active";
  assert.doesNotThrow(() => validateInput(value, now));
  assert.doesNotThrow(() => validateInput(input(), new Date("2026-10-18T23:00:00Z")));
  assert.throws(() => validateInput(input(), new Date("2026-10-28T12:00:00Z")));
});

test("authenticates before reservation and never accepts a public key as a user identity", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request({ timezone: "UTC" }, { Authorization: "" }))).status, 401);
  assert.equal(calls.reserve, 0);
  const rejected = setup({ authenticate: async () => { throw new ApiError(401, "unauthorized", "Invalid session"); } });
  assert.equal((await rejected.handler(request())) .status, 401);
  assert.equal(rejected.calls.reserve, 0);
});

test("cloud reviews load server-owned input and reject client-supplied identity/activity", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request(input()))).status, 400);
  assert.equal((await handler(request({ timezone: "UTC", userId: "someone-else" }))).status, 400);
  assert.equal(calls.reserve, 0);
  const disabled = setup({ loadInput: async () => ({ disabled: true }) });
  assert.equal((await disabled.handler(request())).status, 403);
  assert.equal(disabled.calls.generate, 0);
  const empty = input();
  empty.activity = { tasks: [], stops: [], totalStops: 0, omittedStops: 0 };
  const noData = setup({ loadInput: async () => empty });
  assert.deepEqual(await (await noData.handler(request())).json(), { noData: true });
  assert.equal(noData.calls.reserve, 0);
});

test("body reader cancels slow streams on deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(() => readLimited(stream, 1024, 5), (error) => error.status === 408);
  assert.equal(cancelled, true);
});

test("success reserves, generates and saves exactly once", async () => {
  const { handler, calls } = setup();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await response.json()).analysis, analysis);
  assert.deepEqual(calls, { auth: 1, reserve: 1, generate: 1, finish: 1, fail: 0 });
});

test("cached responses and every quota denial make zero provider calls", async () => {
  const cached = setup({ reserve: async () => ({ outcome: "cached", analysis, model: "gpt-4.1-mini", generatedAt: now.toISOString() }) });
  const response = await cached.handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, true);
  assert.equal(cached.calls.generate, 0);
  for (const [outcome, status] of Object.entries({ disabled: 503, invalid: 400, running: 409, rate_limited: 429, weekly_limit: 429, global_limit: 503, conflict: 409, expired: 410 })) {
    const { handler, calls } = setup({ reserve: async () => ({ outcome }) });
    assert.equal((await handler(request())).status, status);
    assert.equal(calls.generate, 0);
  }
});

test("bounds streamed request bodies and rejects invalid JSON before reserving", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request({ padding: "x".repeat(70_000) }))).status, 413);
  const malformed = new Request("https://example.test", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: "{" });
  assert.equal((await handler(malformed)).status, 400);
  assert.equal((await handler(request({ timezone: "UTC" }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal(calls.reserve, 0);
});

test("CORS allows configured desktop origins, not arbitrary websites", async () => {
  const { handler, calls } = setup();
  const preflight = new Request("https://example.test", { method: "OPTIONS", headers: { Origin: "tauri://localhost" } });
  const response = await handler(preflight);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "tauri://localhost");
  assert.equal((await handler(request({ timezone: "UTC" }, { Origin: "https://evil.example" }))).status, 403);
  assert.equal(calls.auth, 0);
});

test("failures release only the lease state, sanitize errors and never save invented evidence", async () => {
  const { handler, calls } = setup({ generate: async () => { throw new Error("secret-token private task contents"); } });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret-token"));
  assert.equal(calls.fail, 1);
  assert.equal(calls.finish, 0);
  const invented = { ...analysis, mainReasons: [{ reason: "Invented", evidenceStopIds: [99] }] };
  assert.throws(() => validateAnalysis(invented, input().activity));
  const unsupported = setup({ generate: async () => invented });
  assert.equal((await unsupported.handler(request())).status, 502);
  assert.equal(unsupported.calls.finish, 0);
  assert.equal(unsupported.calls.fail, 1);
  const failedSave = setup({ finish: async () => false });
  assert.equal((await failedSave.handler(request())).status, 503);
  assert.equal(failedSave.calls.fail, 1);
});

test("provider fixes model/prompt, disables storage, times out and sanitizes errors", async () => {
  const body = providerBody(input());
  assert.equal(body.model, "gpt-4.1-mini");
  assert.equal(body.store, false);
  assert.equal(body.max_completion_tokens, 6000);
  assert.equal(body.response_format.json_schema.strict, true);
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.equal(init.headers.Authorization, "Bearer server-secret");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(analysis) } }] });
  };
  assert.deepEqual(await generateReview(input(), "server-secret", fakeFetch), analysis);
  await assert.rejects(() => generateReview(input(), "server-secret", async () => new Response("private upstream detail", { status: 401 })), (error) => {
    assert.ok(!error.message.includes("private"));
    assert.ok(!error.message.includes("server-secret"));
    return true;
  });
  for (const choice of [
    { finish_reason: "length", message: { content: JSON.stringify(analysis) } },
    { finish_reason: "stop", message: { refusal: "No", content: JSON.stringify(analysis) } },
    { finish_reason: "stop", message: { content: "invalid-json" } },
  ]) {
    await assert.rejects(() => generateReview(input(), "server-secret", async () => Response.json({ choices: [choice] })), ApiError);
  }
});
