import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setPriceOption, subscribeDefaults, subscribeFromForm,
  renewalPending, cancelDefaults, cancelFromForm,
  chargeDefaults, chargeSetPriceOption, chargeFromForm,
} from './entry.js';
import { svc, period, charge, TODAY } from './fixtures.js';

// ── Also set as current price ───────────────────────────────────────────────

test('setPriceOption: offered when the amount differs, unticked', () => {
  assert.deepEqual(setPriceOption(svc({ price_cents: 1799 }), 1999), { show: true, checked: false });
});

test('setPriceOption: hidden when the amount equals the price', () => {
  assert.deepEqual(setPriceOption(svc({ price_cents: 1799 }), 1799), { show: false, checked: false });
});

test('setPriceOption: ticked by default when the price is unknown', () => {
  assert.deepEqual(setPriceOption(svc({ price_cents: null }), 1299), { show: true, checked: true });
});

test('setPriceOption: a $0 trial is offered but not ticked', () => {
  assert.deepEqual(setPriceOption(svc({ price_cents: null }), 0), { show: true, checked: false });
  assert.deepEqual(setPriceOption(svc({ price_cents: 1199 }), 0), { show: true, checked: false });
});

test('setPriceOption: a blank amount offers nothing', () => {
  assert.deepEqual(setPriceOption(svc({ price_cents: null }), null), { show: false, checked: false });
  assert.deepEqual(setPriceOption(svc({ price_cents: 1799 }), null), { show: false, checked: false });
});

// ── Mark subscribed ─────────────────────────────────────────────────────────

test('subscribeDefaults: today, prefilled with the current price', () => {
  assert.deepEqual(subscribeDefaults(svc({ price_cents: 1799 }), TODAY), { date: TODAY, amount: '17.99', set_price: false });
  assert.deepEqual(subscribeDefaults(svc({ price_cents: null }), TODAY), { date: TODAY, amount: '', set_price: false });
});

const netflix = svc({ id: 'nf', billing_interval: 'monthly', price_cents: 1799 });

test('subscribeFromForm: the defaults plan a period renewing next month', () => {
  const r = subscribeFromForm(subscribeDefaults(netflix, TODAY), { service: netflix, today: TODAY });
  assert.deepEqual(r, {
    plan: {
      period: { service_id: 'nf', started_on: TODAY, renews_on: '2026-12-16' },
      charge: { service_id: 'nf', charged_on: TODAY, amount_cents: 1799, billing_interval: 'monthly', source: 'manual' },
    },
    setPrice: false,
    missed: [],
    errors: {},
  });
});

test('subscribeFromForm: a different amount is recorded; set price only when ticked', () => {
  const base = { date: TODAY, amount: '19.99' };
  const plain = subscribeFromForm({ ...base, set_price: false }, { service: netflix, today: TODAY });
  assert.equal(plain.plan.charge.amount_cents, 1999);
  assert.equal(plain.setPrice, false);
  assert.equal(subscribeFromForm({ ...base, set_price: true }, { service: netflix, today: TODAY }).setPrice, true);
});

test('subscribeFromForm: a ticked box that is not offered is ignored', () => {
  const r = subscribeFromForm({ date: TODAY, amount: '17.99', set_price: true }, { service: netflix, today: TODAY });
  assert.equal(r.setPrice, false);
  const blank = subscribeFromForm({ date: TODAY, amount: '', set_price: true }, { service: netflix, today: TODAY });
  assert.equal(blank.setPrice, false);
  assert.equal(blank.plan.charge.amount_cents, null);
});

test('subscribeFromForm: date must be a real date, not in the future', () => {
  const at = (date) => subscribeFromForm({ date, amount: '1' }, { service: netflix, today: TODAY }).errors.date;
  assert.equal(at(''), 'pick a date');
  assert.equal(at('2026-02-30'), 'not a real date');
  assert.equal(at('11/16/2026'), 'not a real date');
  assert.equal(at('2026-11-17'), "can't be in the future");
  assert.equal(at(TODAY), undefined);
});

test('subscribeFromForm: a bad amount is an error and nothing is planned', () => {
  const r = subscribeFromForm({ date: TODAY, amount: '-3' }, { service: netflix, today: TODAY });
  assert.equal(r.errors.amount, 'enter a price like 12.99');
  assert.equal(r.plan, null);
});

test('subscribeFromForm: refused while a period is renewing (acceptance 7), or when archived', () => {
  const open = period({ service_id: 'nf', started_on: '2026-11-01', renews_on: '2026-12-01' });
  const closed = period({ service_id: 'nf', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' });
  const values = subscribeDefaults(netflix, TODAY);
  assert.match(subscribeFromForm(values, { service: netflix, periods: [closed, open], today: TODAY }).errors.form, /still renewing/);
  assert.deepEqual(subscribeFromForm(values, { service: netflix, periods: [closed], today: TODAY }).errors, {});
  const archived = { ...netflix, archived_at: '2026-10-01T00:00:00+00:00' };
  assert.match(subscribeFromForm(values, { service: archived, today: TODAY }).errors.form, /restore/);
});

test('subscribeFromForm: a backfill lists the renewals catch-up will add (acceptance 6)', () => {
  const r = subscribeFromForm({ date: '2026-08-16', amount: '17.99' }, { service: netflix, today: TODAY });
  assert.equal(r.plan.period.renews_on, '2026-09-16');
  assert.deepEqual(r.missed, ['2026-09-16', '2026-10-16', '2026-11-16']);
});

test('subscribeFromForm: an annual keeper charged last year has no missed renewals yet', () => {
  const nso = svc({ billing_interval: 'annual', price_cents: 2100 });
  const r = subscribeFromForm({ date: '2025-12-02', amount: '21' }, { service: nso, today: TODAY });
  assert.equal(r.plan.period.renews_on, '2026-12-02');
  assert.deepEqual(r.missed, []);
});

test('subscribeFromForm: month-end start renews at month end', () => {
  const r = subscribeFromForm({ date: '2026-10-31', amount: '' }, { service: netflix, today: TODAY });
  assert.equal(r.plan.period.renews_on, '2026-11-30');
});

test('subscribeFromForm: too far back for catch-up is an error', () => {
  const weekly = svc({ billing_interval: 'weekly' });
  const r = subscribeFromForm({ date: '1990-01-01', amount: '1' }, { service: weekly, today: TODAY });
  assert.match(r.errors.date, /too far back/);
  assert.equal(r.plan, null);
});

// ── Mark cancelled ──────────────────────────────────────────────────────────

const current = period({ id: 'p1', started_on: TODAY, renews_on: '2026-12-16' });
const backfill = period({ id: 'p2', started_on: '2026-03-01', renews_on: '2026-04-01' });

test('renewalPending: only an open period whose renews_on has come', () => {
  assert.equal(renewalPending(current, TODAY), false);
  assert.equal(renewalPending(backfill, TODAY), true);
  assert.equal(renewalPending(period({ started_on: '2026-10-16', renews_on: TODAY }), TODAY), true);
  assert.equal(renewalPending({ ...backfill, cancelled_on: '2026-03-01' }, TODAY), false);
});

test('cancelDefaults: today, access until the day before the next charge', () => {
  assert.deepEqual(cancelDefaults(current, TODAY), { cancelled_on: TODAY, access_ends_on: '2026-12-15' });
});

test('cancelDefaults: a backfill with a pending renewal defaults to cancelling on day one', () => {
  assert.deepEqual(cancelDefaults(backfill, TODAY), { cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' });
});

test('cancelDefaults: no renews_on → access ends the day it was cancelled', () => {
  assert.deepEqual(cancelDefaults(period({ started_on: '2026-11-01' }), TODAY), { cancelled_on: TODAY, access_ends_on: TODAY });
});

test('cancelFromForm: the defaults are accepted (acceptance 8)', () => {
  assert.deepEqual(cancelFromForm(cancelDefaults(current, TODAY), { period: current, today: TODAY }), {
    row: { cancelled_on: TODAY, access_ends_on: '2026-12-15' },
    errors: {},
  });
});

test('cancelFromForm: an edited access end is kept, a blank one takes the default', () => {
  const later = cancelFromForm({ cancelled_on: TODAY, access_ends_on: '2026-12-16' }, { period: current, today: TODAY });
  assert.equal(later.row.access_ends_on, '2026-12-16');
  const blank = cancelFromForm({ cancelled_on: TODAY, access_ends_on: '' }, { period: current, today: TODAY });
  assert.equal(blank.row.access_ends_on, '2026-12-15');
});

test('cancelFromForm: access can end the day you cancel, not before', () => {
  const now = cancelFromForm({ cancelled_on: TODAY, access_ends_on: TODAY }, { period: current, today: TODAY });
  assert.deepEqual(now.errors, {});
  const before = cancelFromForm({ cancelled_on: TODAY, access_ends_on: '2026-11-15' }, { period: current, today: TODAY });
  assert.equal(before.errors.access_ends_on, "can't end before you cancelled");
  assert.equal(before.row, null);
});

test('cancelFromForm: cancel date is real, not in the future, not before the start', () => {
  const at = (d) => cancelFromForm({ cancelled_on: d, access_ends_on: '' }, { period: current, today: TODAY }).errors.cancelled_on;
  assert.equal(at(''), 'pick a date');
  assert.equal(at('2026-11-31'), 'not a real date');
  assert.equal(at('2026-11-17'), "can't be in the future");
  assert.equal(at('2026-11-15'), "can't be before it started (nov 16)");
});

test('cancelFromForm: refuses a date on or after an unrecorded renewal', () => {
  const r = cancelFromForm({ cancelled_on: TODAY, access_ends_on: '' }, { period: backfill, today: TODAY });
  assert.match(r.errors.cancelled_on, /after its apr 1 renewal/);
  const ok = cancelFromForm({ cancelled_on: '2026-03-31', access_ends_on: '' }, { period: backfill, today: TODAY });
  assert.deepEqual(ok.row, { cancelled_on: '2026-03-31', access_ends_on: '2026-03-31' });
});

test('cancelFromForm: a bad access date is reported', () => {
  const r = cancelFromForm({ cancelled_on: TODAY, access_ends_on: '2026-02-30' }, { period: current, today: TODAY });
  assert.equal(r.errors.access_ends_on, 'not a real date');
});

test('cancelFromForm: an already cancelled period is refused', () => {
  const done = { ...current, cancelled_on: TODAY, access_ends_on: '2026-12-15' };
  assert.match(cancelFromForm({ cancelled_on: TODAY, access_ends_on: '' }, { period: done, today: TODAY }).errors.form, /already cancelled/);
});

// ── Edit charge ─────────────────────────────────────────────────────────────

const spotify = svc({ id: 'sp', price_cents: 1199 });
const renewal = charge({ id: 'c2', service_id: 'sp', period_id: 'p1', charged_on: '2026-10-20', amount_cents: 1199, source: 'auto' });
const first = charge({ id: 'c1', service_id: 'sp', period_id: 'p1', charged_on: '2026-09-20', amount_cents: 1199 });
const ctx = { charge: renewal, service: spotify, siblings: [first, renewal], today: TODAY };

test('chargeDefaults: the charge as the form shows it', () => {
  assert.deepEqual(chargeDefaults(renewal), { charged_on: '2026-10-20', amount: '11.99', set_price: false });
  assert.deepEqual(chargeDefaults({ ...renewal, amount_cents: null }), { charged_on: '2026-10-20', amount: '', set_price: false });
});

test('chargeSetPriceOption: only once the amount changes, then like Mark subscribed', () => {
  assert.deepEqual(chargeSetPriceOption(renewal, spotify, 1199), { show: false, checked: false });
  assert.deepEqual(chargeSetPriceOption(renewal, spotify, 1299), { show: true, checked: false });
  // changed, but back to the price on file: nothing to save
  assert.deepEqual(chargeSetPriceOption({ ...renewal, amount_cents: 999 }, spotify, 1199), { show: false, checked: false });
  // unknown price: ticked
  assert.deepEqual(chargeSetPriceOption(renewal, svc({ price_cents: null }), 1299), { show: true, checked: true });
  // unknown amount filled in
  assert.deepEqual(chargeSetPriceOption({ ...renewal, amount_cents: null }, spotify, 1299), { show: true, checked: false });
});

test('chargeFromForm: §9 keeper price rise: new amount plus set as current price', () => {
  const r = chargeFromForm({ charged_on: '2026-10-20', amount: '12.99', set_price: true }, ctx);
  assert.deepEqual(r, {
    row: { amount_cents: 1299 },
    price: { price_cents: 1299, price_checked_on: '2026-10-20' },
    errors: {},
  });
});

test('chargeFromForm: only changed columns are written; nothing changed → null', () => {
  assert.deepEqual(chargeFromForm(chargeDefaults(renewal), ctx), { row: null, price: null, errors: {} });
  assert.deepEqual(chargeFromForm({ charged_on: '2026-10-21', amount: '11.99' }, ctx).row, { charged_on: '2026-10-21' });
});

test('chargeFromForm: the price is dated to the (new) charge date', () => {
  const r = chargeFromForm({ charged_on: '2026-10-22', amount: '13', set_price: true }, ctx);
  assert.deepEqual(r.price, { price_cents: 1300, price_checked_on: '2026-10-22' });
});

test('chargeFromForm: a tick that is not offered is ignored', () => {
  assert.equal(chargeFromForm({ charged_on: '2026-10-21', amount: '11.99', set_price: true }, ctx).price, null);
});

test('chargeFromForm: blank amount records unknown', () => {
  assert.deepEqual(chargeFromForm({ charged_on: '2026-10-20', amount: '' }, ctx).row, { amount_cents: null });
});

test('chargeFromForm: two charges in one period cannot share a date', () => {
  const r = chargeFromForm({ charged_on: '2026-09-20', amount: '11.99' }, ctx);
  assert.equal(r.errors.charged_on, 'this period already has a charge on that date');
  // a charge in no period has nothing to collide with
  const loose = { ...renewal, period_id: null };
  assert.deepEqual(chargeFromForm({ charged_on: '2026-09-20', amount: '11.99' }, { ...ctx, charge: loose }).errors, {});
});

test('chargeFromForm: date and amount are validated', () => {
  const r = chargeFromForm({ charged_on: '2026-11-17', amount: 'x' }, ctx);
  assert.deepEqual(r.errors, { charged_on: "can't be in the future", amount: 'enter a price like 12.99' });
  assert.equal(r.row, null);
});
