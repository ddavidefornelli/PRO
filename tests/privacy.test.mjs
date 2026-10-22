import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acknowledgePrivacy, hasPrivacyAcknowledgement, PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../src/privacy-state.ts";
import { privacyPolicyIssues } from "../scripts/check-privacy.mjs";

const storage = (value = null) => {
  const values = new Map(value === null ? [] : [[PRIVACY_ACKNOWLEDGEMENT_KEY, value]]);
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, next) => values.set(key, next) };
};

test("privacy acknowledgement saves only a notice version and time, not consent or account data", () => {
  const store = storage();
  assert.equal(hasPrivacyAcknowledgement(store), false);
  acknowledgePrivacy(store, new Date("2026-10-19T12:00:00.000Z"));
  assert.equal(hasPrivacyAcknowledgement(store), true);
  assert.deepEqual(JSON.parse(store.values.get(PRIVACY_ACKNOWLEDGEMENT_KEY)), {
    version: PRIVACY_POLICY_VERSION, acknowledgedAt: "2026-10-19T12:00:00.000Z",
  });
  assert.equal(store.values.size, 1);
});

test("missing, old, malformed and incomplete acknowledgements require a new notice", () => {
  for (const value of [null, "", "not json", "null", "[]", "false", '"text"', "{}",
    JSON.stringify({ version: "old", acknowledgedAt: "2026-10-19T12:00:00.000Z" }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION, acknowledgedAt: null }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION, acknowledgedAt: 123 }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION, acknowledgedAt: "not a date" }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION, acknowledgedAt: "1" }),
  ]) assert.equal(hasPrivacyAcknowledgement(storage(value)), false, value);
});

test("storage errors do not imply acknowledgement and a failed save stays a failure", () => {
  assert.equal(hasPrivacyAcknowledgement({ getItem() { throw new Error("Blocked"); } }), false);
  assert.throws(() => acknowledgePrivacy({ setItem() { throw new Error("Full"); } }), /Full/);
});

test("the bundled policy and acknowledgement version match", () => {
  const policy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
  assert.ok(policy.split(/\r?\n/).includes(`Version: ${PRIVACY_POLICY_VERSION}`));
  for (const section of ["Who is responsible", "legal basis", "Optional AI", "International transfers", "How long", "Your GDPR rights"]) {
    assert.ok(policy.includes(section), section);
  }
});

test("release check rejects unfinished legal fields and mismatched policy versions", () => {
  const complete = `# Privacy\n\nVersion: ${PRIVACY_POLICY_VERSION}\n\nLast updated: 19 October 2026\n`;
  assert.deepEqual(privacyPolicyIssues(complete), []);
  assert.deepEqual(privacyPolicyIssues(`${complete}\n[TO COMPLETE: legal name]\n[TO COMPLETE: legal name]`), ["[TO COMPLETE: legal name]"]);
  assert.ok(privacyPolicyIssues(complete, "new-version").some((issue) => issue.includes("versions do not match")));
  assert.ok(privacyPolicyIssues("Version: old").some((issue) => issue.includes("last-updated")));
});
