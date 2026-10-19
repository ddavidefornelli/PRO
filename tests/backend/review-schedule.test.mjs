import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { database } from "../helpers/database.mjs";

let fixture;
before(async () => { fixture = await database(); });
after(async () => { await fixture?.db.close(); });
async function schedule(timezone, instant) {
  return (await fixture.db.query("select public.planner_review_schedule($1, $2::timestamptz) result", [timezone, instant])).rows[0].result;
}

for (const [timezone, before, due] of [
  ["UTC", "2026-10-18T15:59:59Z", "2026-10-18T16:00:00Z"],
  ["Europe/Rome", "2026-10-18T13:59:59Z", "2026-10-18T14:00:00Z"],
  ["America/New_York", "2026-10-18T19:59:59Z", "2026-10-18T20:00:00Z"],
  ["Pacific/Kiritimati", "2026-10-18T01:59:59Z", "2026-10-18T02:00:00Z"],
  ["Pacific/Pago_Pago", "2026-10-19T02:59:59Z", "2026-10-19T03:00:00Z"],
]) {
  test(`Sunday 16:00 local boundary: ${timezone}`, async () => {
    const earlier = await schedule(timezone, before);
    assert.equal(earlier.start, "2026-10-05");
    assert.equal(new Date(earlier.nextUpdateAt).toISOString(), due.replace("00Z", "00.000Z"));
    const current = await schedule(timezone, due);
    assert.equal(current.start, "2026-10-12");
    assert.equal(current.end, "2026-10-18");
    assert.equal(current.nextUpdate, "2026-10-25");
  });
}

test("the next Sunday stays at 16:00 across daylight saving changes", async () => {
  for (const [timezone, now, expected] of [
    ["Europe/Rome", "2026-10-18T16:00:00Z", "2026-10-25T15:00:00.000Z"],
    ["America/New_York", "2026-10-25T21:00:00Z", "2026-11-01T21:00:00.000Z"],
  ]) {
    assert.equal(new Date((await schedule(timezone, now)).nextUpdateAt).toISOString(), expected);
  }
});

test("Monday catch-up keeps the Sunday-due week", async () => {
  const result = await schedule("UTC", "2026-10-19T10:00:00Z");
  assert.equal(result.start, "2026-10-12");
  assert.equal(result.nextUpdate, "2026-10-25");
});
