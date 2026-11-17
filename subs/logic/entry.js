// Forms for recording periods and charges (SPEC §7.3, §8.3). Like serviceFromForm,
// each takes the strings a form holds and returns what to write, or errors keyed
// by field ('form' for a problem with no single field).

import { parseYmd } from './dates.js';
import { parseCents, centsToInput } from './services.js';
import { openPeriod } from './status.js';
import { planSubscribe, planCatchUp } from './periods.js';

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
