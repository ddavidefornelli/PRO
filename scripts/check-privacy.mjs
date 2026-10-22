import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PRIVACY_POLICY_VERSION } from "../src/privacy-state.ts";

/** A release hygiene check, not a legal/compliance certification. */
export function privacyPolicyIssues(policy, version = PRIVACY_POLICY_VERSION) {
  const issues = [...new Set(policy.match(/\[TO COMPLETE:[^\]]*\]/g) ?? [])];
  if (/^Status: Draft\b/m.test(policy)) issues.push("The policy is marked as a draft, not ready for public release.");
  if (!policy.split(/\r?\n/).includes(`Version: ${version}`)) issues.push("Policy and first-launch acknowledgement versions do not match.");
  if (!/^Last updated: .+$/m.test(policy)) issues.push("The policy needs a last-updated date.");
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const issues = privacyPolicyIssues(readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8"));
  if (issues.length) {
    console.error(`Privacy policy is not release-ready:\n${issues.map((issue) => `- ${issue}`).join("\n")}\nComplete PRIVACY.md and docs/privacy-release-checklist.md before distribution.`);
    process.exitCode = 1;
  } else {
    console.log("Privacy template fields and notice version checked. Legal and deployment review is still required (docs/privacy-release-checklist.md).");
  }
}
