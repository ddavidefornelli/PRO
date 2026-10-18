import test from "node:test";
import assert from "node:assert/strict";
import { localPublicConfig } from "../scripts/supabase-local.mjs";

const jwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
const status = { API_URL: "http://127.0.0.1:54321", ANON_KEY: jwt("anon"), SERVICE_ROLE_KEY: jwt("service_role") };

test("local desktop config returns only public values, never privileged status fields", () => {
  assert.deepEqual(localPublicConfig(status), {
    PRO_SUPABASE_URL: status.API_URL,
    PRO_SUPABASE_ANON_KEY: status.ANON_KEY,
  });
  assert.deepEqual(localPublicConfig({ ...status, PUBLISHABLE_KEY: "sb_publishable_local" }), {
    PRO_SUPABASE_URL: status.API_URL,
    PRO_SUPABASE_ANON_KEY: "sb_publishable_local",
  });
});

test("local desktop and live smoke config rejects hosted URLs, redirects and URL credentials", () => {
  for (const API_URL of [undefined, "", "https://project.supabase.co", "http://host.docker.internal:54321", "http://127.0.0.1.evil.test:54321", "http://user:password@localhost:54321", "http://localhost:54321/path", "http://localhost:54321?secret=yes", "http://localhost:54321#fragment", "file:///tmp/backend"]) {
    assert.throws(() => localPublicConfig({ ...status, API_URL }));
  }
  assert.throws(() => localPublicConfig(null));
});

test("local config accepts only explicit loopback origins, including IPv6", () => {
  for (const API_URL of ["http://localhost:54321/", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
    assert.equal(localPublicConfig({ ...status, API_URL }).PRO_SUPABASE_URL, new URL(API_URL).origin);
  }
});

test("local config rejects missing, malformed, secret and service-role public keys", () => {
  for (const ANON_KEY of [undefined, null, "", "sb_publishable_", "sb_secret_local", jwt("service_role"), "bad.jwt.value", 42]) {
    assert.throws(() => localPublicConfig({ ...status, ANON_KEY }));
  }
  assert.throws(() => localPublicConfig({ ...status, PUBLISHABLE_KEY: "sb_secret_local" }));
});
