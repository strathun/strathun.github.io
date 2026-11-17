// Period history and charges on service detail (SPEC §8.3).

import { accessEnd } from './status.js';

const newestFirst = (a, b) => (a > b ? -1 : a < b ? 1 : 0);
const openFirst = (a, b) => (b.cancelled_on == null) - (a.cancelled_on == null);

/**
 * A service's periods, newest first, each with its charges (newest first):
 *   { periods: [{ period, open, accessEndsOn, charges }], loose }
 * `loose` holds charges in no known period: period_id is null (the period was
 * deleted outside the app) or names a period that isn't in `periods`.
 * On equal start dates the open period comes first.
 */
export function periodHistory(periods = [], charges = []) {
  const byPeriod = new Map(periods.map((p) => [p.id, []]));
  const loose = [];
  for (const c of charges) (byPeriod.get(c.period_id) ?? loose).push(c);

  const byDate = (list) => list.sort((a, b) => newestFirst(a.charged_on, b.charged_on));
  const entries = periods
    .slice()
    .sort((a, b) => newestFirst(a.started_on, b.started_on) || openFirst(a, b))
    .map((period) => ({
      period,
      open: period.cancelled_on == null,
      accessEndsOn: accessEnd(period),
      charges: byDate(byPeriod.get(period.id)),
    }));
  return { periods: entries, loose: byDate(loose) };
}

/** Total of the known amounts, and how many are unknown: { cents, unknown }. */
export function chargeTotal(charges) {
  let cents = 0;
  let unknown = 0;
  for (const c of charges) {
    if (c.amount_cents == null) unknown += 1;
    else cents += c.amount_cents;
  }
  return { cents, unknown };
}
