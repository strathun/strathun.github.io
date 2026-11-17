// Forms for recording periods and charges (SPEC §7.3, §8.3). Like serviceFromForm,
// each takes the strings a form holds and returns what to write, or errors keyed
// by field ('form' for a problem with no single field).

import { formatDay, parseYmd } from './dates.js';
import { parseCents, centsToInput } from './services.js';
import { openPeriod } from './status.js';
import { planSubscribe, planCancel, planCatchUp } from './periods.js';

/** A date input: required, a real calendar date, and not after `today`. */
function dateField(input, today) {
  const s = String(input ?? '').trim();
  if (!s) return { error: 'pick a date' };
  try {
    parseYmd(s);
  } catch {
    return { error: 'not a real date' };
  }
  if (s > today) return { error: "can't be in the future" };
  return { value: s };
}

/**
 * "Also set as current price" (SPEC §7.3): offered when an amount is entered and
 * the price is unknown or different. Ticked by default when the price is unknown,
 * except for $0: a free trial is rarely the price you'll pay next.
 * A blank amount offers nothing, as there's no price to save.
 */
export function setPriceOption(service, amountCents) {
  if (amountCents == null) return { show: false, checked: false };
  if (service.price_cents == null) return { show: true, checked: amountCents > 0 };
  return { show: amountCents !== service.price_cents, checked: false };
}

// ── Mark subscribed ─────────────────────────────────────────────────────────

/** Form defaults: charged today, for the current price. */
export function subscribeDefaults(service, today) {
  return { date: today, amount: centsToInput(service.price_cents), set_price: false };
}

/**
 * Mark subscribed form → { plan, setPrice, missed, errors }.
 * `plan` is planSubscribe()'s { period, charge }. `missed` lists the renewals the
 * next load's catch-up will record, when the date is a full interval ago or more.
 * `setPrice` is true only when the option is offered and ticked.
 */
export function subscribeFromForm(values, { service, periods = [], today }) {
  const errors = {};
  if (service.archived_at) errors.form = 'restore the service before marking it subscribed.';
  else if (openPeriod(periods)) errors.form = 'a period is still renewing. mark it cancelled first.';

  const date = dateField(values.date, today);
  if (date.error) errors.date = date.error;
  const amount = parseCents(values.amount);
  if (amount.error) errors.amount = amount.error;

  let plan = null;
  let missed = [];
  if (!date.error && !amount.error) {
    plan = planSubscribe(service, date.value, amount.value);
    try {
      const open = { id: null, ...plan.period, cancelled_on: null };
      missed = planCatchUp(open, service, today).charges.map((c) => c.charged_on);
    } catch {
      errors.date = 'too far back: that would record over 1000 renewals';
    }
  }

  if (Object.keys(errors).length) return { plan: null, setPrice: false, missed: [], errors };
  const setPrice = setPriceOption(service, amount.value).show && !!values.set_price;
  return { plan, setPrice, missed, errors };
}

// ── Mark cancelled ──────────────────────────────────────────────────────────

/**
 * True when the period's renewal date has passed but catch-up hasn't recorded it:
 * a backfill entered this session. It was cancelled before that renewal, or the
 * next load will record the renewals.
 */
export function renewalPending(period, today) {
  return period.cancelled_on == null && period.renews_on != null && period.renews_on <= today;
}

/**
 * Form defaults (SPEC §7.3): cancelled today, access to the day before the next
 * charge. For a backfill with a renewal pending, cancelled on the start day instead
 * (the rotation habit), since cancelling today would skip the renewals in between.
 */
export function cancelDefaults(period, today) {
  const date = renewalPending(period, today) ? period.started_on : today;
  return planCancel(period, date);
}

/**
 * Mark cancelled form → { row: { cancelled_on, access_ends_on }, errors }.
 * A blank access end takes the default (renews_on − 1 day).
 */
export function cancelFromForm(values, { period, today }) {
  const errors = {};
  if (period.cancelled_on != null) errors.form = 'this period is already cancelled.';

  const date = dateField(values.cancelled_on, today);
  if (date.error) errors.cancelled_on = date.error;
  else if (date.value < period.started_on) {
    errors.cancelled_on = `can't be before it started (${formatDay(period.started_on, today)})`;
  } else if (period.renews_on && date.value >= period.renews_on) {
    errors.cancelled_on = `that's after its ${formatDay(period.renews_on, today)} renewal. pick an earlier date, or reload so the renewal is recorded first`;
  }

  let accessEndsOn = null;
  const ends = String(values.access_ends_on ?? '').trim();
  if (ends) {
    try {
      parseYmd(ends);
      accessEndsOn = ends;
    } catch {
      errors.access_ends_on = 'not a real date';
    }
  }
  if (accessEndsOn && !errors.cancelled_on && accessEndsOn < date.value) {
    errors.access_ends_on = "can't end before you cancelled";
  }

  if (Object.keys(errors).length) return { row: null, errors };
  return { row: planCancel(period, date.value, accessEndsOn), errors };
}

// ── Edit charge ─────────────────────────────────────────────────────────────

/** Form values for a charge. */
export function chargeDefaults(charge) {
  return { charged_on: charge.charged_on, amount: centsToInput(charge.amount_cents), set_price: false };
}

/**
 * "Also set as current price" when editing a charge (SPEC §8.3): only once the
 * amount has changed, and then by the same rule as Mark subscribed.
 */
export function chargeSetPriceOption(charge, service, amountCents) {
  if (amountCents === (charge.amount_cents ?? null)) return { show: false, checked: false };
  return setPriceOption(service, amountCents);
}

/**
 * Edit charge form → { row, price, errors }.
 * `row` holds only the changed columns (charged_on, amount_cents), or null if
 * nothing changed. `price` is { price_cents, price_checked_on } to save on the
 * service, dated to the charge, when the option is offered and ticked; else null.
 * `siblings` are the other charges of the same period: two can't share a date.
 */
export function chargeFromForm(values, { charge, service, siblings = [], today }) {
  const errors = {};
  const date = dateField(values.charged_on, today);
  if (date.error) errors.charged_on = date.error;
  else if (charge.period_id != null && siblings.some((c) => c.id !== charge.id && c.period_id === charge.period_id && c.charged_on === date.value)) {
    errors.charged_on = 'this period already has a charge on that date';
  }
  const amount = parseCents(values.amount);
  if (amount.error) errors.amount = amount.error;
  if (Object.keys(errors).length) return { row: null, price: null, errors };

  const row = {};
  if (date.value !== charge.charged_on) row.charged_on = date.value;
  if (amount.value !== (charge.amount_cents ?? null)) row.amount_cents = amount.value;
  const setPrice = chargeSetPriceOption(charge, service, amount.value).show && !!values.set_price;
  return {
    row: Object.keys(row).length ? row : null,
    price: setPrice ? { price_cents: amount.value, price_checked_on: date.value } : null,
    errors,
  };
}
