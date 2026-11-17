// Services: form parsing, money display and dashboard grouping (SPEC §6, §8.1, §8.4).
//
// The form works in strings ("12.99", "", "2026-11-17"); the database works in rows
// (1299, null, '2026-11-17'). formValues() goes row → form and serviceFromForm()
// goes back, validating on the way.

import { parseYmd } from './dates.js';
import { serviceStatus } from './status.js';
import { alertsFor } from './alerts.js';

export const CATEGORIES = ['video', 'music', 'gaming', 'storage', 'shopping', 'ai', 'other'];
export const ROLES = ['keeper', 'rotator'];
export const INTERVALS = ['weekly', 'monthly', 'quarterly', 'annual'];
export const INTERVAL_SHORT = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', annual: 'yr' };

export const NAME_MAX = 100;
export const LEAD_DAYS_MAX = 365;

/** Defaults for a new service: the editable `services` columns (SPEC §6). */
export const NEW_SERVICE = {
  name: '',
  category: null,
  role: 'rotator',
  billing_interval: 'monthly',
  price_cents: null,
  price_checked_on: null,
  manage_url: null,
  manage_path: null,
  help_url: null,
  url_verified: false,
  cancel_lead_days: 1,
  notes: null,
};

/** Columns the form edits. id, user_id, archived_at and created_at are not among them. */
export const SERVICE_FIELDS = Object.keys(NEW_SERVICE);

// ── money ───────────────────────────────────────────────────────────────────

const MONEY = /^\$?\s*(\d{0,7})(?:\.(\d{0,2}))?$/;

// One comma and at most two digits after it: a comma-decimal keyboard ('12,99').
// '1,299' is left alone (and rejected): it could be a thousands separator.
const COMMA_DECIMAL = /^[^.,]*,\d{0,2}$/;

/**
 * Dollars typed by a person → integer cents, without float math.
 * '' → { value: null } (unknown). '12.99' → 1299, '$12' → 1200, '.5' → 50,
 * '12,99' → 1299. Negatives, thousands commas and a third decimal place → { error }.
 */
export function parseCents(input) {
  let s = String(input ?? '').trim();
  if (s === '') return { value: null };
  if (COMMA_DECIMAL.test(s)) s = s.replace(',', '.');
  const match = MONEY.exec(s);
  if (!match || (match[1] === '' && !match[2])) return { error: 'enter a price like 12.99' };
  const dollars = Number(match[1] || '0');
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  return { value: dollars * 100 + cents };
}

/** 1299 → '$12.99', 123456 → '$1,234.56', null → '—'. */
export function formatCents(cents) {
  if (cents == null) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** 1299 → '12.99', the form's way of showing a price. null → ''. */
export function centsToInput(cents) {
  if (cents == null) return '';
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** '$12.99 / mo', or '— / mo' when the price is unknown. */
export function formatPrice(service) {
  return `${formatCents(service.price_cents)} / ${INTERVAL_SHORT[service.billing_interval] ?? service.billing_interval}`;
}

// ── urls ────────────────────────────────────────────────────────────────────

/** True only for http(s) URLs, so a `javascript:` value can never become a link. */
export function isWebUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  try {
    const { protocol } = new URL(s);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// ── form ↔ row ──────────────────────────────────────────────────────────────

/** A service row → the strings and booleans the form shows. */
export function formValues(service = NEW_SERVICE) {
  const s = { ...NEW_SERVICE, ...service };
  return {
    name: s.name ?? '',
    category: s.category ?? '',
    role: s.role,
    billing_interval: s.billing_interval,
    price: centsToInput(s.price_cents),
    price_checked_on: s.price_checked_on ?? '',
    manage_url: s.manage_url ?? '',
    manage_path: s.manage_path ?? '',
    help_url: s.help_url ?? '',
    url_verified: !!s.url_verified,
    cancel_lead_days: String(s.cancel_lead_days ?? 1),
    notes: s.notes ?? '',
  };
}

const text = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Form values → { row, errors }. `errors` maps field → message; `row` is null
 * unless errors is empty. `previous` is the saved row when editing.
 *
 * Changing the price fills price_checked_on with `today`, unless the date
 * was changed too (SPEC §8.4).
 */
export function serviceFromForm(values, { today, previous = null }) {
  const errors = {};

  const name = text(values.name);
  if (!name) errors.name = 'name is required';
  else if (name.length > NAME_MAX) errors.name = `keep it under ${NAME_MAX} characters`;

  const category = text(values.category);
  if (category && !CATEGORIES.includes(category)) errors.category = 'pick a category';

  const role = text(values.role);
  if (!ROLES.includes(role)) errors.role = 'pick keeper or rotator';

  const billing_interval = text(values.billing_interval);
  if (!INTERVALS.includes(billing_interval)) errors.billing_interval = 'pick a billing interval';

  const price = parseCents(values.price);
  if (price.error) errors.price = price.error;
  const price_cents = price.error ? null : price.value;

  let price_checked_on = text(values.price_checked_on);
  if (price_checked_on) {
    try {
      parseYmd(price_checked_on);
      if (price_checked_on > today) errors.price_checked_on = "can't be in the future";
    } catch {
      errors.price_checked_on = 'not a real date';
    }
  }
  const priceChanged = price_cents != null && price_cents !== (previous?.price_cents ?? null);
  const dateUntouched = price_checked_on === (previous?.price_checked_on ?? null);
  if (priceChanged && dateUntouched) price_checked_on = today;

  const manage_url = text(values.manage_url);
  if (manage_url && !isWebUrl(manage_url)) errors.manage_url = 'must start with https://';

  const help_url = text(values.help_url);
  if (help_url && !isWebUrl(help_url)) errors.help_url = 'must start with https://';

  let cancel_lead_days = 1;
  const lead = String(values.cancel_lead_days ?? '').trim();
  if (lead !== '') {
    if (!/^\d+$/.test(lead) || Number(lead) > LEAD_DAYS_MAX) {
      errors.cancel_lead_days = `a whole number from 0 to ${LEAD_DAYS_MAX}`;
    } else {
      cancel_lead_days = Number(lead);
    }
  }

  if (Object.keys(errors).length) return { row: null, errors };

  return {
    row: {
      name,
      category,
      role,
      billing_interval,
      price_cents,
      price_checked_on,
      manage_url,
      manage_path: text(values.manage_path),
      help_url,
      url_verified: !!values.url_verified,
      cancel_lead_days,
      notes: text(values.notes),
    },
    errors,
  };
}

/**
 * The service that already uses this name (case-insensitive, archived included),
 * other than `exceptId`. Mirrors the services_user_name_uq index so the form can
 * explain the clash before the database rejects it.
 */
export function findNameConflict(services, name, exceptId = null) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return services.find((s) => s.id !== exceptId && s.name.trim().toLowerCase() === key) ?? null;
}

// ── dashboard ───────────────────────────────────────────────────────────────

const byName = (a, b) => {
  const x = a.service.name.toLowerCase();
  const y = b.service.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Dashboard groups (SPEC §8.1), each sorted by name. Entries are
 * { service, status, period, accessEndsOn }. Archived services go only in
 * `archived`, whatever their status.
 */
export function groupServices(services, periodsByService, today) {
  const groups = { renewing: [], ending: [], inactive: [], archived: [] };
  for (const service of services) {
    const entry = { service, ...serviceStatus(periodsByService.get(service.id) ?? [], today) };
    groups[service.archived_at ? 'archived' : entry.status].push(entry);
  }
  for (const list of Object.values(groups)) list.sort(byName);
  return groups;
}

const BADGE_TYPES = new Set(['verify_link', 'price_unknown', 'check_price']);

/** Alerts that depend only on the service row, shown as badges on its row (SPEC §8.1). */
export function serviceBadges(service, today) {
  return alertsFor({ service, today }).filter((a) => BADGE_TYPES.has(a.type));
}

/** A renewing service can't be archived: it would keep charging with no alerts (SPEC §8.4). */
export function canArchive(status) {
  return status !== 'renewing';
}

/** Setup checklist item 1 (SPEC §11): how many non-archived services have a price. */
export function setupProgress(services) {
  const live = services.filter((s) => !s.archived_at);
  return { priced: live.filter((s) => s.price_cents != null).length, total: live.length };
}
