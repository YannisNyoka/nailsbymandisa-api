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
