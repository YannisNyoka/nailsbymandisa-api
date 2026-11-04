import {
  currentWeekDateStrings,
  currentMonthDateStrings,
  todayDateString,
  weekdayKeyForDate,
  periodRangeSoFar,
  sameStretchRangeSoFar,
} from '../../src/utils/businessTime.js';

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

describe('periodRangeSoFar', () => {
  it.each(['week', 'month', 'year'])('period 0 (%s) ends today and never starts after today', (unit) => {
    const { start, end } = periodRangeSoFar(unit, 0);
    expect(end).toBe(todayDateString());
    expect(start <= end).toBe(true);
  });

  it('week period 0 starts on a Monday', () => {
    expect(weekdayKeyForDate(periodRangeSoFar('week', 0).start)).toBe('mon');
  });
  it('month period 0 starts on the 1st', () => {
    expect(periodRangeSoFar('month', 0).start.endsWith('-01')).toBe(true);
  });
  it('year period 0 starts on Jan 1', () => {
    expect(periodRangeSoFar('year', 0).start.endsWith('-01-01')).toBe(true);
  });

  it('a past week period (1 ago) spans exactly 7 days and ends the day before this week starts', () => {
    const thisWeekStart = periodRangeSoFar('week', 0).start;
    const lastWeek = periodRangeSoFar('week', 1);
    const dayBeforeThisWeek = new Date(new Date(`${thisWeekStart}T00:00:00Z`).getTime() - 86_400_000);
    expect(lastWeek.end).toBe(dayBeforeThisWeek.toISOString().slice(0, 10));
    const spanDays = (new Date(`${lastWeek.end}T00:00:00Z`) - new Date(`${lastWeek.start}T00:00:00Z`)) / 86_400_000;
    expect(spanDays).toBe(6);
  });

  it('a past month period (1 ago) ends the day before this month starts and begins on the 1st', () => {
    const thisMonthStart = periodRangeSoFar('month', 0).start;
    const lastMonth = periodRangeSoFar('month', 1);
    const dayBeforeThisMonth = new Date(new Date(`${thisMonthStart}T00:00:00Z`).getTime() - 86_400_000);
    expect(lastMonth.end).toBe(dayBeforeThisMonth.toISOString().slice(0, 10));
    expect(lastMonth.start.endsWith('-01')).toBe(true);
  });

  it('a past year period (1 ago) is Jan 1 - Dec 31 of the previous year', () => {
    const thisYear = Number(todayDateString().slice(0, 4));
    const lastYear = periodRangeSoFar('year', 1);
    expect(lastYear.start).toBe(`${thisYear - 1}-01-01`);
    expect(lastYear.end).toBe(`${thisYear - 1}-12-31`);
  });
});

describe('sameStretchRangeSoFar', () => {
  it.each(['week', 'month', 'year'])(
    "(%s) never extends past the compared-to period's own true end, even when the current period has more elapsed days than the previous one had total (e.g. March 31 vs. February)",
    (unit) => {
      const { start, end } = sameStretchRangeSoFar(unit, 1);
      const fullPrevious = periodRangeSoFar(unit, 1);
      expect(start).toBe(fullPrevious.start);
      expect(end >= start).toBe(true);
      expect(end <= fullPrevious.end).toBe(true);
    }
  );

  it('week: same stretch last week ends exactly 7 days before today', () => {
    const { end } = sameStretchRangeSoFar('week', 1);
    const sevenDaysAgo = new Date(new Date(`${todayDateString()}T00:00:00Z`).getTime() - 7 * 86_400_000);
    expect(end).toBe(sevenDaysAgo.toISOString().slice(0, 10));
  });
});
