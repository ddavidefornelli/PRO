import assert from "node:assert/strict";
import test from "node:test";
import { calendarYear } from "../src/activity-calendar.ts";

// Every weekday/leap-year layout, plus Gregorian century exceptions.
for (const year of [...Array.from({ length: 28 }, (_, i) => 2000 + i), 2099, 2100, 2101, 2399, 2400, 2401]) {
  test(`calendar Gregorian/layout invariants for ${year}`, () => {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = leap ? 366 : 365;
    const end = `${year}-12-31`, start = `${year}-01-01`;
    const empty = calendarYear(year, end, []);
    assert.equal(empty.days.length, days);
    assert.equal(empty.days[0].day, start); assert.equal(empty.days.at(-1).day, end);
    assert.equal(empty.days.some((d) => d.day === `${year}-02-29`), leap);
    assert.ok(empty.weeks >= 53 && empty.weeks <= 54);
    const positions = new Set();
    for (const [index, day] of empty.days.entries()) {
      assert.equal(day.row, (empty.days[0].row + index) % 7);
      assert.ok(day.week >= 0 && day.week < empty.weeks);
      positions.add(`${day.week}:${day.row}`);
      assert.equal(day.future, false);
    }
    assert.equal(positions.size, days);
    const completions = empty.days.map((d, i) => ({ day: d.day, count: i % 7 }));
    const cutoff = `${year}-06-15`;
    const partial = calendarYear(year, cutoff, completions);
    assert.equal(partial.total, completions.filter((c) => c.day <= cutoff).reduce((s, c) => s + c.count, 0));
    for (const day of partial.days) if (day.day > cutoff) { assert.equal(day.count, 0); assert.equal(day.future, true); }
  });
}
