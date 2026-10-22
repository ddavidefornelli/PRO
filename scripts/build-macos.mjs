import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function selectIdentity(listing, name) {
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(name ?? "")) {
    throw new Error("Set APPLE_SIGNING_IDENTITY to the full Developer ID Application certificate name from Keychain Access.");
  }
  const matches = [...listing.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"]+)"/g)]
    .filter((match) => match[2] === name);
  if (matches.length !== 1) {
    throw new Error("The requested signing identity must match exactly one valid certificate with its private key in Keychain. Install it or resolve duplicate identities before building.");
  }
  return { fingerprint: matches[0][1], team: name.match(/\(([A-Z0-9]{10})\)$/)[1] };
}

export function validatePublicConfig(env) {
  const url = new URL(env.PRO_SUPABASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PRO_SUPABASE_URL must be an HTTPS project origin.");
  }
  const key = env.PRO_SUPABASE_ANON_KEY ?? "";
  const parts = key.split(".");
  let anon = false;
  if (parts.length === 3) {
    try { anon = JSON.parse(Buffer.from(parts[1], "base64url").toString()).role === "anon"; }
    catch { /* Invalid public configuration is rejected below. */ }
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && !anon) {
    throw new Error("Set PRO_SUPABASE_ANON_KEY to a public publishable/anon key. Privileged keys must never be embedded in a release.");
  }
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Resolve the error before distributing prune.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function main() {
  if (process.platform !== "darwin") throw new Error("Signed macOS builds must run on macOS.");
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Only --check is supported; release signing cannot be overridden with extra build flags.");
  const identity = selectIdentity(run("security", ["find-identity", "-v", "-p", "codesigning"], true), process.env.APPLE_SIGNING_IDENTITY);
  validatePublicConfig(process.env);
  run("npm", ["run", "privacy:check"]);
  if (process.argv.includes("--check")) {
    console.log("Signing identity, public project configuration and privacy template fields are ready.");
    return;
  }
  const config = JSON.stringify({ bundle: {
    active: true,
    macOS: { signingIdentity: identity.fingerprint, hardenedRuntime: true },
  } });
  run("npm", ["exec", "--", "tauri", "build", "--bundles", "app", "--config", config]);
  const app = join(project, "src-tauri/target/release/bundle/macos/prune.app");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const details = run("codesign", ["--display", "--verbose=4", app], true);
  if (!details.includes(`TeamIdentifier=${identity.team}\n`) || !details.includes("Identifier=com.pro.desktop\n") || !details.includes("Authority=Developer ID Application:")) {
    throw new Error("Built app does not have the expected Developer ID signature, team and bundle identifier. Do not distribute it.");
  }
  if (process.env.PRO_NOTARY_PROFILE) {
    const temporary = mkdtempSync(join(tmpdir(), "pro-notarize-"));
    try {
      const archive = join(temporary, "prune.zip");
      run("ditto", ["-c", "-k", "--keepParent", app, archive]);
      run("xcrun", ["notarytool", "submit", archive, "--keychain-profile", process.env.PRO_NOTARY_PROFILE, "--wait"]);
      run("xcrun", ["stapler", "staple", app]);
      run("xcrun", ["stapler", "validate", app]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    console.log(`Signed, notarized app: ${app}`);
  } else {
    console.log(`Signed app: ${app}\nNot notarized. For distribution, set PRO_NOTARY_PROFILE and rebuild (see docs/macos-signing.md).`);
  }
  console.log("Quit other prune instances, then install and launch this prune.app from /Applications. npm run desktop remains an unsigned development workflow.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
