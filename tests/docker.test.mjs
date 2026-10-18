import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Docker browser image matches the exact locked Playwright version", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const imageVersion = dockerfile.match(/^FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-noble AS tests$/m)?.[1];
  assert.equal(imageVersion, lock.packages["node_modules/@playwright/test"].version,
    "Update the Playwright Docker tag whenever the npm dependency changes.");
});
