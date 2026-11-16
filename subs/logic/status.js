// Service status (SPEC §7.1), from the service's latest period and `today`.

import { addDays } from './dates.js';

/** Map(service_id → rows) for periods, charges or watchlist items. */
export function groupByService(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.service_id);
    if (list) list.push(row);
    else map.set(row.service_id, [row]);
  }
  return map;
}

/** Latest started_on wins. On a tie, the uncancelled period wins. */
export function latestPeriod(periods) {
  let best = null;
  for (const p of periods) {
    if (
      !best ||
      p.started_on > best.started_on ||
      (p.started_on === best.started_on && p.cancelled_on == null && best.cancelled_on != null)
    ) {
      best = p;
    }
  }
  return best;
}

/**
 * Last day of access for a cancelled period: access_ends_on, or renews_on − 1 day
 * if it was left blank, or cancelled_on as a last resort. Null while renewing.
 */
export function accessEnd(period) {
  if (period.cancelled_on == null) return null;
  if (period.access_ends_on) return period.access_ends_on;
  if (period.renews_on) return addDays(period.renews_on, -1);
  return period.cancelled_on;
}

/** { status: 'renewing' | 'ending' | 'inactive', period, accessEndsOn } */
export function serviceStatus(periods, today) {
  const period = latestPeriod(periods);
  if (!period) return { status: 'inactive', period: null, accessEndsOn: null };
  if (period.cancelled_on == null) return { status: 'renewing', period, accessEndsOn: null };
  const accessEndsOn = accessEnd(period);
  return { status: accessEndsOn >= today ? 'ending' : 'inactive', period, accessEndsOn };
}
