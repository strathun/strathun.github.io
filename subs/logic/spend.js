// Spend metrics for a selected year (SPEC §7.5). All inputs include archived services.

import { effectiveMonth } from './dates.js';
import { slicesInYear, monthlyTotals } from './amortize.js';
import { groupByService, serviceStatus } from './status.js';

// Charges per month as a fraction [times, months]. Multiplying before dividing keeps
// results exact where possible (5000 * 1 / 12, not 5000 * (1/12)).
const PER_MONTH = { weekly: [52, 12], monthly: [1, 1], quarterly: [1, 3], annual: [1, 12] };

/** Monthly equivalent of the current price, in (possibly fractional) cents. Unknown price → 0. */
export function runRateCents(service) {
  if (service.price_cents == null) return 0;
  const [times, months] = PER_MONTH[service.billing_interval];
  return (service.price_cents * times) / months;
}

const sum = (xs) => xs.reduce((t, x) => t + x, 0);

/**
 * {
 *   month,      M for this year (0 future, 1–12)
 *   monthly,    slice totals for Jan–Dec (same numbers as the year view totals row)
 *   thisMonth,  slices in month M            (null when M = 0)
 *   soFar,      slices Jan through M         (null when M = 0)
 *   average,    soFar ÷ M, unrounded         (null when M = 0)
 *   cash,       amounts charged in the year
 *   committed,  slices already paid for months after M
 *   runRate,    run rate for later months with nothing committed, unrounded
 *   projected,  soFar + committed + runRate, unrounded ("if nothing changes")
 * }
 */
export function spendMetrics({ services, periods, charges, year, today }) {
  const M = effectiveMonth(year, today);
  const slices = slicesInYear(charges, year);
  const monthly = monthlyTotals(slices);

  const soFar = M ? sum(monthly.slice(0, M)) : null;
  const committed = sum(monthly.slice(M));

  const periodsByService = groupByService(periods);
  let runRate = 0;
  for (const service of services) {
    if (serviceStatus(periodsByService.get(service.id) ?? [], today).status !== 'renewing') continue;
    const rate = runRateCents(service);
    const row = slices.get(service.id);
    for (let i = M; i < 12; i++) {
      if (row?.[i] == null) runRate += rate;
    }
  }

  const prefix = `${year}-`;
  const cash = sum(
    charges
      .filter((c) => c.amount_cents != null && c.charged_on.startsWith(prefix))
      .map((c) => c.amount_cents),
  );

  return {
    month: M,
    monthly,
    thisMonth: M ? monthly[M - 1] : null,
    soFar,
    average: M ? soFar / M : null,
    cash,
    committed,
    runRate,
    projected: (soFar ?? 0) + committed + runRate,
  };
}
