import { currentWeekDateStrings, currentMonthDateStrings, todayDateString, weekdayKeyForDate } from '../../src/utils/businessTime.js';

// Deliberately no date mocking (not a pattern used elsewhere in this test suite) —
// these assert structural invariants that hold no matter what day the suite happens to
// run on, rather than exact values.
function assertConsecutiveNoGaps(dates) {
  for (let i = 1; i < dates.length; i += 1) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`);
    const next = new Date(`${dates[i]}T00:00:00Z`);
    expect(next.getTime() - prev.getTime()).toBe(86_400_000);
  }
}

describe('currentWeekDateStrings', () => {
  it('runs from this Monday through today inclusive, with no gaps or duplicates', () => {
    const dates = currentWeekDateStrings();
    expect(dates[dates.length - 1]).toBe(todayDateString());
    expect(weekdayKeyForDate(dates[0])).toBe('mon');
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates.length).toBeLessThanOrEqual(7);
    assertConsecutiveNoGaps(dates);
  });
});

describe('currentMonthDateStrings', () => {
  it('runs from the 1st of this calendar month through today inclusive, with no gaps or duplicates', () => {
    const dates = currentMonthDateStrings();
    expect(dates[dates.length - 1]).toBe(todayDateString());
    expect(dates[0].endsWith('-01')).toBe(true);
    expect(new Set(dates).size).toBe(dates.length);
    assertConsecutiveNoGaps(dates);
  });
});
