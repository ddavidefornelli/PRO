import assert from "node:assert/strict";
import { test } from "node:test";
import { database, ALICE, BOB } from "../helpers/database.mjs";

test("review inputs exclude placeholder stops before counting and limiting, without deleting logs", async () => {
  const f = await database();
  try {
    await f.call("set_weekly_ai_enabled", { enabled: true, consentVersion: "weekly-ai-v1" });
    const task = await f.create();
    const other = await f.create("Other user's task", BOB);
    const seed = async (user, id, day, reason, count) => f.db.query(`
      insert into public.planner_stops(user_id, task_id, reason, stopped_at, stopped_on)
      select $1, $2, $3, 0, $4::date from generate_series(1, $5::integer)
    `, [user, id, reason, day, count]);
    // Placeholders newer than the real explanation must not consume the 200-entry limit.
    for (const day of [f.dates.week, f.dates.today]) {
      await seed(ALICE, task.id, day, "Spotify", 1);
      await seed(ALICE, task.id, day, "Reason not provided", 205);
      await seed(BOB, other.id, day, "Private reason", 1);
    }
    for (const rpc of ["planner_review_input", "planner_preview_input"]) {
      const input = (await f.db.query(`select public.${rpc}($1, 'UTC') result`, [ALICE])).rows[0].result;
      assert.deepEqual(input.activity.stops.map((s) => s.reason), ["Spotify"]);
      assert.equal(input.activity.totalStops, 1);
      assert.equal(input.activity.omittedStops, 0);
    }
    assert.equal((await f.db.query("select count(*)::integer n from public.planner_stops where reason = 'Reason not provided'")).rows[0].n, 410);
    await f.db.query("delete from public.planner_stops where reason <> 'Reason not provided'");
    const input = (await f.db.query("select public.planner_preview_input($1, 'UTC') result", [ALICE])).rows[0].result;
    assert.deepEqual(input.activity.stops, []);
    assert.equal(input.activity.totalStops, 0);
    assert.equal(input.activity.omittedStops, 0);
  } finally {
    await f.db.close();
  }
});
