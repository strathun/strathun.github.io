import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPriceOption, subscribeDefaults, subscribeFromForm } from './entry.js';
import { svc, period, TODAY } from './fixtures.js';

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
