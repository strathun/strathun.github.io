// Alerts for one service (SPEC §7.2), and the dashboard Alerts list (§8.1).

import { addDays, daysBetween } from './dates.js';
import { serviceStatus, latestPeriod } from './status.js';

export const DECIDE_WINDOW_DAYS = 14;
export const PRICE_STALE_DAYS = 180;

/**
 * Alerts in display order. Each is { type, ...details }:
 *   cancel_now     { renewsOn, olderStart }
 *   decide_by      { date, overdue, renewsOn, olderStart }
 *   verify_link
 *   price_unknown
 *   check_price    { checkedOn }   (null = never checked)
 *   amount_unknown { count }
 * `renewsOn` is the renewing period's next charge (null if it has none). `olderStart`
 * is that period's start when another period started later, the sign of a backfill
 * left uncancelled (§7.1); otherwise null.
 * `periods` and `charges` are this service's rows only.
 */
export function alertsFor({ service, periods = [], charges = [], today }) {
  if (service.archived_at) return [];
  const alerts = [];

  const { status, period } = serviceStatus(periods, today);
  if (status === 'renewing') {
    const renewsOn = period.renews_on ?? null;
    const olderStart = latestPeriod(periods) === period ? null : period.started_on;
    if (service.role === 'rotator') {
      alerts.push({ type: 'cancel_now', renewsOn, olderStart });
    } else if (service.role === 'keeper' && renewsOn) {
      const date = addDays(renewsOn, -(service.cancel_lead_days ?? 1));
      if (daysBetween(today, date) <= DECIDE_WINDOW_DAYS) {
        alerts.push({ type: 'decide_by', date, overdue: date < today, renewsOn, olderStart });
      }
    }
  }

  if (!service.url_verified) alerts.push({ type: 'verify_link' });

  if (service.price_cents == null) {
    alerts.push({ type: 'price_unknown' });
  } else if (!service.price_checked_on || daysBetween(service.price_checked_on, today) > PRICE_STALE_DAYS) {
    alerts.push({ type: 'check_price', checkedOn: service.price_checked_on ?? null });
  }

  const unknown = charges.filter((c) => c.amount_cents == null).length;
  if (unknown) alerts.push({ type: 'amount_unknown', count: unknown });

  return alerts;
}

/** The dashboard Alerts list holds these, in this order. The rest are row badges. */
const LIST_TYPES = ['cancel_now', 'decide_by', 'amount_unknown'];

/** The date an alert sorts by within its type; null sorts after any date. */
function sortDate(alert) {
  if (alert.type === 'cancel_now') return alert.renewsOn;
  if (alert.type === 'decide_by') return alert.date;
  return '';
}

function compare(a, b) {
  const rank = LIST_TYPES.indexOf(a.alert.type) - LIST_TYPES.indexOf(b.alert.type);
  if (rank) return rank;
  const x = sortDate(a.alert);
  const y = sortDate(b.alert);
  if (x !== y) {
    if (x == null) return 1;
    if (y == null) return -1;
    return x < y ? -1 : 1;
  }
  // Same name order as the dashboard groups (groupServices).
  const m = a.service.name.toLowerCase();
  const n = b.service.name.toLowerCase();
  return m < n ? -1 : m > n ? 1 : 0;
}

/**
 * The dashboard Alerts list (SPEC §8.1) as [{ service, alert }]: Cancel now (by
 * next charge), Decide by (by date, so passed ones first), then Amount unknown;
 * ties by name. Archived services have no alerts (§7.2), so they never appear.
 */
export function dashboardAlerts({ services, periodsByService, chargesByService, today }) {
  const entries = [];
  for (const service of services) {
    const alerts = alertsFor({
      service,
      periods: periodsByService.get(service.id) ?? [],
      charges: chargesByService.get(service.id) ?? [],
      today,
    });
    for (const alert of alerts) {
      if (LIST_TYPES.includes(alert.type)) entries.push({ service, alert });
    }
  }
  return entries.sort(compare);
}
