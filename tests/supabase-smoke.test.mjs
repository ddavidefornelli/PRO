import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the opt-in command's orchestration without Docker, real Auth or credentials.
async function runFixture(t, failCreate = false) {
  const users = new Map();
  const deleted = [];
  let createdTask = false;
  const serviceKey = "private-fixture-service-key";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const reply = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url.startsWith("/auth/v1/admin/")) {
      if (req.headers.authorization !== `Bearer ${serviceKey}`) return reply({}, 401);
      if (req.method === "DELETE") { deleted.push(req.url.split("/").at(-1)); return reply({}); }
      if (req.url.endsWith("/users")) {
        const id = `user-${users.size + 1}`;
        users.set(body.email, id);
        return reply({ id });
      }
      if (req.url.endsWith("/generate_link")) return reply({ email_otp: "123456" });
    }
    if (req.url === "/auth/v1/verify") {
      // A modern publishable key is an apikey, not a user bearer token.
      if (req.headers.authorization || body.type !== "email" || body.token !== "123456") return reply({}, 401);
      return reply({ access_token: `token-${users.get(body.email)}` });
    }
    if (req.url === "/rest/v1/rpc/planner_call") {
      const alice = req.headers.authorization === "Bearer token-user-1";
      if (body.p_action === "dashboard") return reply({ today: "2026-10-18", todayTasks: alice && createdTask ? [{ id: "task-1" }] : [] });
      if (body.p_action === "create_task") {
        if (failCreate) return reply({}, 500);
        createdTask = true;
        return reply({ id: "task-1" });
      }
      if (body.p_action === "rename_task") return reply({}, 404);
      if (body.p_action === "queue_protocol") return reply({ version: 1 });
    }
    if (req.url.startsWith("/rest/v1/planner_tasks?")) return reply([]);
    reply({}, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const dir = await mkdtemp(join(tmpdir(), "pro-smoke-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const npm = join(dir, "npm-fixture.mjs");
  await writeFile(npm, "console.log(process.env.PRO_FIXTURE_STATUS);\n");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./supabase/smoke.mjs", import.meta.url))], {
    env: {
      ...process.env, npm_execpath: npm,
      PRO_FIXTURE_STATUS: JSON.stringify({ API_URL: `http://127.0.0.1:${server.address().port}`, PUBLISHABLE_KEY: "sb_publishable_fixture", SERVICE_ROLE_KEY: serviceKey }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.doesNotMatch(output, /private-fixture-service-key|token-user-/);
  return { code, output, deleted };
}

test("live smoke orchestration verifies public email codes and removes both disposable users", { timeout: 20_000 }, async (t) => {
  const result = await runFixture(t);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /account isolation passed/);
  assert.deepEqual(result.deleted, ["user-1", "user-2"]);
});

test("live smoke orchestration cleans up both users when a planner check fails", { timeout: 20_000 }, async (t) => {
  const result = await runFixture(t, true);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /HTTP 500/);
  assert.deepEqual(result.deleted, ["user-1", "user-2"]);
});
