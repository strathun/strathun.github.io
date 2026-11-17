// Subscribing, cancelling and automatic renewals (SPEC §7.3).
//
// These functions only plan writes. They return the rows to insert and the fields
// to update; the data layer applies them. Catch-up is idempotent because the same
// rows always produce the same plan, and the (period_id, charged_on) unique index
// drops duplicates if two tabs apply it at once.

import { addDays, addInterval, daysInMonth, parseYmd } from './dates.js';
import { groupByService } from './status.js';

const MAX_CATCH_UP_CHARGES = 1000;

/**
 * Mark subscribed on `date`, for the amount charged (SPEC §7.3; defaults to the
 * current price, null = unknown). The database function mark_subscribed() writes
 * the period, then the charge with the new period's id, in one transaction.
 */
export function planSubscribe(service, date, amountCents = service.price_cents ?? null) {
  return {
    period: {
      service_id: service.id,
      started_on: date,
      renews_on: addInterval(date, service.billing_interval),
    },
    charge: {
      service_id: service.id,
      charged_on: date,
      amount_cents: amountCents,
      billing_interval: service.billing_interval,
      source: 'manual',
    },
  };
}

/** Mark cancelled on `date`. Access ends the day before renewal unless the user gives the real date. */
export function planCancel(period, date, accessEndsOn) {
  if (period.cancelled_on != null) throw new Error('This period is already cancelled.');
  return {
    cancelled_on: date,
    access_ends_on: accessEndsOn ?? (period.renews_on ? addDays(period.renews_on, -1) : date),
  };
}

/**
 * The renewal after period.renews_on. Renewals land on the day of started_on,
 * clamped to month end, so a Jan 31 start renews Feb 28 then Mar 31. If renews_on
 * was edited to some other day, that day becomes the renewal day.
 */
export function nextRenewal(period, interval) {
  if (interval === 'weekly') return addInterval(period.renews_on, 'weekly');
  const startDay = parseYmd(period.started_on).d;
  const r = parseYmd(period.renews_on);
  const onStartDay = r.d === Math.min(startDay, daysInMonth(r.y, r.m));
  return addInterval(period.renews_on, interval, 1, onStartDay ? startDay : r.d);
}

/**
 * Charges owed for an uncancelled period whose renews_on is today or earlier,
 * and the renews_on to save afterwards: { charges, renews_on }.
 */
export function planCatchUp(period, service, today) {
  const charges = [];
  let renewsOn = period.renews_on;
  if (period.cancelled_on != null || renewsOn == null) return { charges, renews_on: renewsOn };

  while (renewsOn <= today) {
    if (charges.length >= MAX_CATCH_UP_CHARGES) {
      throw new Error(`Catch-up would record more than ${MAX_CATCH_UP_CHARGES} charges for one period; check its dates.`);
    }
    charges.push({
      service_id: period.service_id,
      period_id: period.id,
      charged_on: renewsOn,
      amount_cents: service.price_cents ?? null,
      billing_interval: service.billing_interval,
      source: 'auto',
    });
    renewsOn = nextRenewal({ ...period, renews_on: renewsOn }, service.billing_interval);
  }
  return { charges, renews_on: renewsOn };
}

/**
 * Catch-up for every period that needs it: [{ period_id, from_renews_on, renews_on, charges }].
 * from_renews_on is the value it was planned from, so the data layer can advance
 * renews_on only if no other tab has advanced it already.
 */
export function planCatchUpAll({ services, periods, today }) {
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const work = [];
  for (const [serviceId, list] of groupByService(periods)) {
    const service = serviceById.get(serviceId);
    if (!service) continue;
    for (const period of list) {
      const { charges, renews_on } = planCatchUp(period, service, today);
      if (charges.length) work.push({ period_id: period.id, from_renews_on: period.renews_on, renews_on, charges });
    }
  }
  return work;
}
