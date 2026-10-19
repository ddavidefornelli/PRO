import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { database, ALICE } from "../helpers/database.mjs";

let fixture;
before(async () => { fixture = await database(); });
after(async () => { await fixture?.db.close(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.db.exec("update public.ai_controls set development_unlimited = false");
  await fixture.call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
});
const preview = async () => (await fixture.db.query("select public.reserve_review_preview($1) result", [ALICE])).rows[0].result;
const weekly = async () => (await fixture.db.query("select public.reserve_weekly_review($1, $2, $3, 'weekly-ai-v1') result", [ALICE, fixture.dates.week, "a".repeat(64)])).rows[0].result;

async function unlimited() {
  await fixture.db.exec("update public.ai_controls set development_unlimited = true, daily_attempt_limit = 1, monthly_attempt_limit = 1");
}

test("production preview cooldown still applies by default", async () => {
  const claim = await preview();
  assert.equal(claim.outcome, "reserved");
  await fixture.db.query("select public.finish_review_preview($1, $2)", [claim.id, claim.leaseToken]);
  assert.equal((await preview()).outcome, "rate_limited");
});

test("development permits unlimited immediate previews beyond global caps", async () => {
  await unlimited();
  for (let i = 0; i < 5; i++) {
    const claim = await preview();
    assert.equal(claim.outcome, "reserved");
    assert.equal((await preview()).outcome, "running");
    await fixture.db.query("select public.finish_review_preview($1, $2)", [claim.id, claim.leaseToken]);
  }
  const overview = await fixture.call("weekly_overview");
  assert.equal(overview.developmentUnlimited, true);
  assert.equal(overview.available, true);
});

test("development permits immediate failed weekly retries beyond three attempts", async () => {
  await unlimited();
  for (let i = 0; i < 5; i++) {
    const claim = await weekly();
    assert.equal(claim.outcome, "reserved");
    assert.equal((await weekly()).outcome, "running");
    await fixture.db.query("select public.fail_weekly_review($1, $2)", [claim.id, claim.leaseToken]);
  }
});

test("development keeps consent and the server kill switch", async () => {
  await unlimited();
  await fixture.call("set_weekly_ai_enabled", { enabled: false, consentVersion: "weekly-ai-v1" });
  assert.equal((await preview()).outcome, "disabled");
  await fixture.db.exec("update public.ai_controls set enabled = false");
  assert.equal((await weekly()).outcome, "disabled");
});
