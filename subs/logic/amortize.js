// Amortization (SPEC §7.4): spread each charge over the months it pays for.

import { addMonths, monthKey } from './dates.js';

const COVERAGE_MONTHS = { weekly: 1, monthly: 1, quarterly: 3, annual: 12 };

export function coverageMonths(interval) {
  const n = COVERAGE_MONTHS[interval];
  if (!n) throw new RangeError(`Unknown billing interval: ${interval}`);
  return n;
}

/**
 * Splits a charge into monthly slices: [{ month: 'YYYY-MM', cents }].
 * Remainder cents go to the latest months, so slices always sum to the charge.
 * Unknown amounts (null) produce no slices and are excluded from totals.
 */
export function sliceCharge(charge) {
  if (charge.amount_cents == null) return [];
  const n = coverageMonths(charge.billing_interval);
  const base = Math.floor(charge.amount_cents / n);
  const remainder = charge.amount_cents % n;
  return Array.from({ length: n }, (_, i) => ({
    month: monthKey(addMonths(charge.charged_on, i)),
    cents: base + (i >= n - remainder ? 1 : 0),
  }));
}

/**
 * Slices that fall in `year`, per service: Map(service_id → 12 entries).
 * An entry is null when the service has no slice that month, so callers can tell
 * "nothing committed" apart from a 0¢ slice.
 */
export function slicesInYear(charges, year) {
  const prefix = `${String(year).padStart(4, '0')}-`;
  const byService = new Map();
  for (const charge of charges) {
    for (const { month, cents } of sliceCharge(charge)) {
      if (!month.startsWith(prefix)) continue;
      let row = byService.get(charge.service_id);
      if (!row) byService.set(charge.service_id, (row = Array(12).fill(null)));
      const i = Number(month.slice(5, 7)) - 1;
      row[i] = (row[i] ?? 0) + cents;
    }
  }
  return byService;
}

/** Per-month totals across services (12 integers). Year view and spend tiles share this. */
export function monthlyTotals(slicesByService) {
  const totals = Array(12).fill(0);
  for (const row of slicesByService.values()) {
    row.forEach((cents, i) => { totals[i] += cents ?? 0; });
  }
  return totals;
}
