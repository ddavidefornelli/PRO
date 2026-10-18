import assert from "node:assert/strict";
import test from "node:test";
import { calendarYear } from "../src/activity-calendar.ts";

test("calendar years include every day, aligned Sunday through Saturday", () => {
  for (const year of [2000, 2024, 2025, 2026, 2028]) {
    const { days, weeks } = calendarYear(year, `${year}-12-31`, []);
    assert.equal(days[0].day, `${year}-01-01`);
    assert.equal(days.at(-1).day, `${year}-12-31`);
    assert.equal(new Set(days.map(({ day }) => day)).size, days.length);
    assert.equal(days.length, year % 4 === 0 ? 366 : 365);
    assert.equal(weeks, Math.ceil((days[0].row + days.length) / 7));
    for (const [index, day] of days.entries()) {
      assert.equal(day.row, new Date(`${day.day}T12:00:00Z`).getUTCDay());
      assert.equal(day.week * 7 + day.row, days[0].row + index);
    }
  }
});

test("leap years include February 29 and can require 54 week columns", () => {
  const leap = calendarYear(2028, "2028-12-31", []);
  assert.equal(leap.weeks, 54);
  assert.equal(leap.days[59].day, "2028-02-29");
  assert.equal(calendarYear(2026, "2026-12-31", []).days[59].day, "2026-03-01");
});

test("totals include only completed days in the selected year", () => {
  const result = calendarYear(2026, "2026-10-17", [
    { day: "2025-12-31", count: 3 },
    { day: "2026-01-01", count: 2 },
    { day: "2026-10-17", count: 1 },
    { day: "2026-10-18", count: 3 },
    { day: "2027-01-01", count: 2 },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.days.find(({ day }) => day === "2026-10-17").future, false);
  const upcoming = result.days.find(({ day }) => day === "2026-10-18");
  assert.equal(upcoming.future, true);
  assert.equal(upcoming.count, 0);
});

test("empty and historical years render without inventing activity", () => {
  const empty = calendarYear(2026, "2026-01-01", []);
  assert.equal(empty.total, 0);
  assert.equal(empty.days.filter(({ future }) => !future).length, 1);
  const historical = calendarYear(2024, "2026-10-17", [{ day: "2024-02-29", count: 3 }]);
  assert.equal(historical.total, 3);
  assert.ok(historical.days.every(({ future }) => !future));
});
