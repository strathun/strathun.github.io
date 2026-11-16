// Year view grid (SPEC §7.6): which services were active in which month, and what each cost.

import { effectiveMonth, monthStart, monthEnd } from './dates.js';
import { slicesInYear, monthlyTotals } from './amortize.js';
import { accessEnd, groupByService } from './status.js';

/** Access window [start, end] for a period; a renewing period runs to today. */
function accessWindow(period, today) {
  return [period.started_on, period.cancelled_on == null ? today : accessEnd(period)];
}

/**
 * {
 *   month,   M for this year
 *   rows:    [{ service, cells: [{ month: 1–12, active, cents | null, future }] }]
 *            in the order of `services`, including archived ones
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

  return { month: M, rows, totals: monthlyTotals(slices) };
}
