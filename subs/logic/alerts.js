// Alerts for one service (SPEC §7.2).

import { addDays, daysBetween } from './dates.js';
import { serviceStatus } from './status.js';

export const DECIDE_WINDOW_DAYS = 14;
export const PRICE_STALE_DAYS = 180;

/**
 * Alerts in display order. Each is { type, ...details }:
 *   cancel_now
 *   decide_by      { date, overdue }
 *   verify_link
 *   price_unknown
 *   check_price    { checkedOn }   (null = never checked)
 *   amount_unknown { count }
 * `periods` and `charges` are this service's rows only.
 */
export function alertsFor({ service, periods = [], charges = [], today }) {
  if (service.archived_at) return [];
  const alerts = [];

  const { status, period } = serviceStatus(periods, today);
  if (status === 'renewing') {
    if (service.role === 'rotator') {
      alerts.push({ type: 'cancel_now' });
    } else if (service.role === 'keeper' && period.renews_on) {
      const date = addDays(period.renews_on, -(service.cancel_lead_days ?? 1));
      if (daysBetween(today, date) <= DECIDE_WINDOW_DAYS) {
        alerts.push({ type: 'decide_by', date, overdue: date < today });
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
