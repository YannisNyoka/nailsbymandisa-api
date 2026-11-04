// §6.5 — timezone-safe date handling. Appointment dates/times are stored as plain
// YYYY-MM-DD / HH:MM strings (never as a Date read with local-timezone getters), and
// "now" is computed via a fixed business-timezone offset rather than the server
// process's TZ, so behavior doesn't change depending on where/how the server runs.

// PLACEHOLDER — South Africa Standard Time (UTC+2, no DST). Move to SETTINGS if the
// salon ever needs a configurable timezone.
export const BUSINESS_TZ_OFFSET_MINUTES = 120;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function nowInBusinessTz() {
  return new Date(Date.now() + BUSINESS_TZ_OFFSET_MINUTES * 60_000);
}

export function todayDateString() {
  return dateStringFor(new Date());
}

// Same business-tz rule as todayDateString(), for an arbitrary instant (e.g. a payment's
// createdAt) rather than "now" — used to bucket records into calendar days for trend
// reporting (§4.12 admin overview charts).
export function dateStringFor(date) {
  const d = new Date(date.getTime() + BUSINESS_TZ_OFFSET_MINUTES * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// N calendar dates ending today (inclusive), oldest first — the x-axis for trend charts.
export function lastNDateStrings(n) {
  const dates = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(nowInBusinessTz().getTime() - i * 86_400_000);
    dates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return dates;
}

// All calendar dates from this week's Monday through today (inclusive) — for "this
// week" figures, as opposed to lastNDateStrings' rolling N-day window. getUTCDay() is
// 0=Sun..6=Sat; (day + 6) % 7 turns that into "days since Monday" (Monday itself -> 0,
// Sunday -> 6).
export function currentWeekDateStrings() {
  const now = nowInBusinessTz();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const dates = [];
  for (let i = daysSinceMonday; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return dates;
}

// All calendar dates from the 1st of this month through today (inclusive) — for "this
// month" figures, as opposed to lastNDateStrings' rolling N-day window.
export function currentMonthDateStrings() {
  const now = nowInBusinessTz();
  const dates = [];
  for (let day = 1; day <= now.getUTCDate(); day += 1) {
    dates.push(`${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(day)}`);
  }
  return dates;
}

function dateStringFromUTCDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Start of the named calendar period ('week' = Monday, 'month' = the 1st, 'year' =
// Jan 1) containing `date` — a BUSINESS_TZ-shifted Date, read/returned via UTC getters
// per this file's convention (see nowInBusinessTz).
function startOfPeriod(date, unit) {
  if (unit === 'week') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7; // getUTCDay is 0=Sun..6=Sat
    return new Date(date.getTime() - daysSinceMonday * 86_400_000);
  }
  if (unit === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1)); // year
}

// The named period's true calendar end (Sunday / the month's last day / Dec 31) given
// its start.
function endOfPeriod(start, unit) {
  if (unit === 'week') return new Date(start.getTime() + 6 * 86_400_000);
  if (unit === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return new Date(Date.UTC(start.getUTCFullYear(), 11, 31)); // year
}

// Moves a period start `count` periods forward (negative = backward) — e.g.
// shiftPeriodStart(thisMonthStart, 'month', -1) is last month's 1st. Uses Date.UTC's
// month/year rollover rather than fixed-day arithmetic, since months/years aren't a
// fixed number of days.
function shiftPeriodStart(start, unit, count) {
  if (unit === 'week') return new Date(start.getTime() + count * 7 * 86_400_000);
  if (unit === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + count, 1));
  return new Date(Date.UTC(start.getUTCFullYear() + count, 0, 1)); // year
}

// Calendar bounds (inclusive, YYYY-MM-DD strings) of the named period ('week' = Monday-
// Sunday, 'month' = calendar month, 'year' = calendar year) `periodsAgo` periods back
// from the current one (0 = this period). The end date is capped at today when
// periodsAgo is 0 — the current period isn't over yet — every other value gets the
// period's true calendar end, since a past period is always already complete. Powers
// the Business Growth panel's period comparisons and 8-period trend bars
// (adminService.getBusinessGrowth).
export function periodRangeSoFar(unit, periodsAgo = 0) {
  const now = nowInBusinessTz();
  const currentStart = startOfPeriod(now, unit);
  const start = shiftPeriodStart(currentStart, unit, -periodsAgo);
  const end = periodsAgo === 0 ? now : endOfPeriod(start, unit);
  return { start: dateStringFromUTCDate(start), end: dateStringFromUTCDate(end) };
}

// Bounds (inclusive, YYYY-MM-DD strings) of the first N calendar days of the period
// `periodsAgo` back, where N = how many days have elapsed so far in the CURRENT period
// — an apples-to-apples slice of a past period ("same point last week/month/year") to
// compare against a current period that isn't over yet. Capped at the past period's own
// true end — e.g. comparing March 31 (elapsed 30 days into the month) against February
// must land on Feb 28/29, not overflow 30 days past Feb 1 into March.
export function sameStretchRangeSoFar(unit, periodsAgo) {
  const now = nowInBusinessTz();
  const currentStart = startOfPeriod(now, unit);
  const elapsedDays = Math.round((now.getTime() - currentStart.getTime()) / 86_400_000);
  const pastStart = shiftPeriodStart(currentStart, unit, -periodsAgo);
  const pastPeriodEnd = endOfPeriod(pastStart, unit);
  const uncappedEnd = new Date(pastStart.getTime() + elapsedDays * 86_400_000);
  const end = uncappedEnd.getTime() > pastPeriodEnd.getTime() ? pastPeriodEnd : uncappedEnd;
  return { start: dateStringFromUTCDate(pastStart), end: dateStringFromUTCDate(end) };
}

export function nowTimeString() {
  const d = nowInBusinessTz();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Weekday key ('mon'..'sun') for a YYYY-MM-DD date string, independent of server TZ.
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function weekdayKeyForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Converts a (date, time) pair in business-local wall time to the real UTC instant it
// represents, for elapsed-time math (cancellation windows, "is this in the past").
export function toInstant(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - BUSINESS_TZ_OFFSET_MINUTES * 60_000);
}

export function addMinutesToTime(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

export function hoursBetween(instantA, instantB) {
  return (instantB.getTime() - instantA.getTime()) / 3_600_000;
}

export function timeRangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}
