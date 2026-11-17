// Calendar-date helpers (SPEC §7). A date is a 'YYYY-MM-DD' string, the same shape
// Supabase returns for `date` columns, and strings in this shape sort chronologically.
//
// Arithmetic works on whole year/month/day numbers. Date.UTC is used only as a
// timezone-free day counter, so no timezone or DST change can move a date.
// todayLocal() is the one place that reads a clock, and it uses local parts.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function toYmd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseYmd(s) {
  const match = typeof s === 'string' && YMD.exec(s);
  if (!match) throw new TypeError(`Expected a YYYY-MM-DD date, got ${JSON.stringify(s)}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new RangeError(`Not a real calendar date: ${s}`);
  }
  return { y, m, d };
}

/** Today's local calendar date. Pass `now` in tests. */
export function todayLocal(now = new Date()) {
  return toYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function dayNumber(s) {
  const { y, m, d } = parseYmd(s);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDayNumber(n) {
  const t = new Date(n * DAY_MS);
  return toYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function addDays(s, n) {
  return fromDayNumber(dayNumber(s) + n);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

/**
 * Adds n months, clamping to month end (Jan 31 + 1 = Feb 28/29).
 * `anchorDay` replaces the source day before clamping, so a renewal that was
 * clamped to Feb 28 can return to the 31st in March.
 */
export function addMonths(s, n, anchorDay) {
  const { y, m, d } = parseYmd(s);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = index - ny * 12 + 1;
  return toYmd(ny, nm, Math.min(anchorDay ?? d, daysInMonth(ny, nm)));
}

export const INTERVAL_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

/** Adds n billing intervals. Weekly adds 7 days; the rest add clamped months. */
export function addInterval(s, interval, n = 1, anchorDay) {
  if (interval === 'weekly') return addDays(s, 7 * n);
  const months = INTERVAL_MONTHS[interval];
  if (!months) throw new RangeError(`Unknown billing interval: ${interval}`);
  return addMonths(s, months * n, anchorDay);
}

/** 'YYYY-MM' for a date. */
export function monthKey(s) {
  parseYmd(s);
  return s.slice(0, 7);
}

export function monthStart(y, m) {
  return toYmd(y, m, 1);
}

export function monthEnd(y, m) {
  return toYmd(y, m, daysInMonth(y, m));
}

export const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 'dec 3' for a date in today's year, 'dec 3, 2027' otherwise. */
export function formatDay(s, today) {
  const { y, m, d } = parseYmd(s);
  const label = `${MONTH_SHORT[m - 1]} ${d}`;
  return parseYmd(today).y === y ? label : `${label}, ${y}`;
}

/** SPEC §7 month M for year Y: today's month, 12 for a past year, 0 for a future year. */
export function effectiveMonth(year, today) {
  const { y, m } = parseYmd(today);
  if (year < y) return 12;
  if (year > y) return 0;
  return m;
}
