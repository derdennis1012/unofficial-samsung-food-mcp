/**
 * Calendar-date helpers. Dates are plain "YYYY-MM-DD" strings; all arithmetic is done in UTC on the
 * year/month/day numbers, so it never depends on the machine's time zone or daylight saving.
 * "Today" is the user's local calendar date.
 */

const pad = (n) => String(n).padStart(2, '0');
const parts = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) throw new Error(`invalid date: ${ymd} (expected YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round trip: Date.UTC silently rolls 2026-02-31 over to March 3rd.
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error(`invalid date: ${ymd} (no such calendar day)`);
  }
  return [y, mo, d];
};

/** Local calendar date of a Date (default: now). */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const utcMs = (ymd) => {
  const [y, m, d] = parts(ymd);
  return Date.UTC(y, m - 1, d);
};

/** "2026-12-31" + 1 -> "2027-01-01" */
export function addDays(ymd, n) {
  const d = new Date(utcMs(ymd) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from a to b (negative if b is earlier). */
export function daysBetween(a, b) {
  return Math.round((utcMs(b) - utcMs(a)) / 86400000);
}

/** Checks from <= to and an inclusive span of at most maxDays. */
export function assertRange(from, to, maxDays = 60) {
  const span = daysBetween(from, to) + 1;
  if (span < 1) throw new Error(`"from" (${from}) must not be after "to" (${to})`);
  if (span > maxDays) throw new Error(`date range too long: ${span} days (maximum ${maxDays})`);
  return span;
}
