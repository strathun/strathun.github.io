// Year view grid (SPEC §7.6): which services were active in which month, and what each cost.

import { effectiveMonth, monthStart, monthEnd, parseYmd } from './dates.js';
import { slicesInYear, monthlyTotals } from './amortize.js';
import { accessEnd, groupByService, byName } from './status.js';

/** Access window [start, end] for a period; a renewing period runs to today. */
function accessWindow(period, today) {
  return [period.started_on, period.cancelled_on == null ? today : accessEnd(period)];
}

/**
 * {
 *   month,   M for this year
 *   rows:    [{ service, cells: [{ month: 1–12, active, cents | null, future }] }]
 *            sorted by name (SPEC §8.2), including archived ones
 *   totals:  12 integers, identical to spendMetrics().monthly
 * }
 */
export function yearView({ services, periods, charges, year, today }) {
  const M = effectiveMonth(year, today);
  const slices = slicesInYear(charges, year);
  const periodsByService = groupByService(periods);

  const rows = [];
  for (const service of services) {
    const windows = (periodsByService.get(service.id) ?? []).map((p) => accessWindow(p, today));
    const sliceRow = slices.get(service.id);
    const cells = [];
    for (let m = 1; m <= 12; m++) {
      const future = m > M;
      const from = monthStart(year, m);
      const to = monthEnd(year, m);
      const active = !future && windows.some(([start, end]) => start <= to && end >= from);
      cells.push({ month: m, active, cents: sliceRow?.[m - 1] ?? null, future });
    }
    if (cells.some((c) => c.active || c.cents != null)) rows.push({ service, cells });
  }

  rows.sort(byName);
  return { month: M, rows, totals: monthlyTotals(slices) };
}

/**
 * Years the switcher offers (SPEC §8.2): from the earliest period start or charge
 * through next year, which shows committed slices and the projection.
 */
export function yearRange({ periods, charges, today }) {
  const thisYear = parseYmd(today).y;
  let first = thisYear;
  for (const p of periods) first = Math.min(first, parseYmd(p.started_on).y);
  for (const c of charges) first = Math.min(first, parseYmd(c.charged_on).y);
  return { first, last: thisYear + 1 };
}

/** The nearest year in `range`, so a stale or typed URL still shows something (acceptance 22). */
export function clampYear(year, { first, last }) {
  return Math.min(Math.max(year, first), last);
}
