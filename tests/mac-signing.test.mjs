import test from "node:test";
import assert from "node:assert/strict";
import { selectIdentity, validatePublicConfig } from "../scripts/build-macos.mjs";

const name = "Developer ID Application: Fixture Developer (ABC1234567)";
const hash = "A".repeat(40);
const listing = `  1) ${hash} "${name}"\n     1 valid identities found`;

test("release signing requires the exact installed Developer ID identity", () => {
  assert.deepEqual(selectIdentity(listing, name), { fingerprint: hash, team: "ABC1234567" });
  for (const identity of [undefined, "-", "", "Apple Development: Fixture (ABC1234567)", "Developer ID Application: Other (ABC1234567)"]) {
    assert.throws(() => selectIdentity(listing, identity));
  }
  assert.throws(() => selectIdentity("0 valid identities found", name));
  assert.throws(() => selectIdentity(`${listing}\n2) ${"B".repeat(40)} "${name}"`, name));
});

test("release configuration accepts public keys, not privileged keys", () => {
  const config = { PRO_SUPABASE_URL: "https://fixture.supabase.co", PRO_SUPABASE_ANON_KEY: "sb_publishable_fixture" };
  assert.doesNotThrow(() => validatePublicConfig(config));
  const jwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  assert.doesNotThrow(() => validatePublicConfig({ ...config, PRO_SUPABASE_ANON_KEY: jwt("anon") }));
  for (const key of [undefined, "", "sb_secret_fixture", jwt("service_role"), "bad.jwt.value"]) {
    assert.throws(() => validatePublicConfig({ ...config, PRO_SUPABASE_ANON_KEY: key }));
  }
  for (const url of [undefined, "http://fixture.supabase.co", "https://user:pass@fixture.supabase.co", "https://fixture.supabase.co/path", "https://fixture.supabase.co?key=secret", "https://fixture.supabase.co#fragment"]) {
    assert.throws(() => validatePublicConfig({ ...config, PRO_SUPABASE_URL: url }));
  }
});
