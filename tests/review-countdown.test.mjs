import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCountdown } from "../src/review-countdown.ts";

const week = { nextUpdate: "2026-10-25", nextUpdateAt: "2026-10-25T16:00:00Z" };

test("countdown uses the timezone-aware server instant", () => {
  const countdown = reviewCountdown(week, Date.parse("2026-10-23T13:55:54Z"));
  assert.deepEqual(countdown.values, [2, 2, 4, 6]);
  assert.equal(countdown.due, false);
  assert.ok(countdown.progress > 0 && countdown.progress < 1);
  const offset = reviewCountdown({ nextUpdate: "2026-10-25", nextUpdateAt: "2026-10-25T16:00:00+02:00" }, Date.parse("2026-10-25T13:00:00Z"));
  assert.deepEqual(offset.values, [0, 1, 0, 0]);
});

test("countdown clamps at both boundaries without negative numbers", () => {
  const due = reviewCountdown(week, Date.parse("2026-10-25T16:00:01Z"));
  assert.equal(due.due, true);
  assert.deepEqual(due.values, [0, 0, 0, 0]);
  assert.equal(due.progress, 1);
  assert.equal(reviewCountdown(week, Date.parse("2026-10-01T00:00:00Z")).progress, 0);
});

test("legacy dates use 4 p.m. local time and invalid dates are safe", () => {
  const countdown = reviewCountdown({ nextUpdate: "2026-10-25" }, new Date("2026-10-25T15:00:00").getTime());
  assert.deepEqual(countdown.values, [0, 1, 0, 0]);
  assert.equal(reviewCountdown({ nextUpdate: "not-a-date" }), null);
});
