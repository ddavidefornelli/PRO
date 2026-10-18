import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Never use linked/hosted configuration for a local launch or smoke test. */
export function localPublicConfig(status) {
  let url;
  try { url = new URL(status?.API_URL); }
  catch { throw new Error("Local Supabase did not return a valid API_URL."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Refusing nonlocal Supabase configuration. Start the local Docker backend first.");
  }
  const key = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  let anon = false;
  if (typeof key === "string" && key.split(".").length === 3) {
    try { anon = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon"; }
    catch { /* Invalid or privileged public configuration fails closed below. */ }
  }
  if (typeof key !== "string" || (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && !anon)) {
    throw new Error("Local Supabase did not return a public publishable/anon key.");
  }
  // Deliberately return only public values, not the status command's service-role key.
  return { PRO_SUPABASE_URL: url.origin, PRO_SUPABASE_ANON_KEY: key };
}

export function localStatus() {
  if (!process.env.npm_execpath) throw new Error("Run this command through npm, as documented.");
  // Invoke npm's JS entrypoint rather than npm.cmd, so this also works on Windows.
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "exec", "--", "supabase", "status", "--output", "json"], {
    cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not read the local Docker backend. Run npm run backend:start first.");
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("Local Supabase status was not valid JSON. Check the pinned CLI installation."); }
}

export function main() {
  const config = localPublicConfig(localStatus());
  console.log("Launching the debug desktop app against local Supabase (public configuration only).");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "desktop"], {
    cwd: project, env: { ...process.env, ...config }, stdio: "inherit",
  });
  if (result.error) throw new Error("Could not start the native desktop toolchain. Check the Tauri prerequisites.");
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
