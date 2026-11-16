import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendMetrics, runRateCents } from './spend.js';
import { svc, period, charge } from './fixtures.js';

// §7.5 worked example 1: a $100 annual charge on Jan 1, 2026, still renewing.
const hundred = svc({ id: 'h', role: 'keeper', billing_interval: 'annual', price_cents: 10000 });
const hundredPeriod = period({ service_id: 'h', started_on: '2026-01-01', renews_on: '2027-01-01' });
const hundredCharge = charge({ service_id: 'h', charged_on: '2026-01-01', amount_cents: 10000, billing_interval: 'annual' });
const example1 = { services: [hundred], periods: [hundredPeriod], charges: [hundredCharge], year: 2026 };

test('§7.5 worked example, January: this month $8.33, average $8.33, so far $8.33, cash $100', () => {
  const m = spendMetrics({ ...example1, today: '2026-01-15' });
  assert.equal(m.thisMonth, 833);
  assert.equal(m.average, 833);
  assert.equal(m.soFar, 833);
  assert.equal(m.cash, 10000);
});

test('§7.5 worked example, June: average $8.33, so far $49.98', () => {
  const m = spendMetrics({ ...example1, today: '2026-06-15' });
  assert.equal(m.average, 833);
  assert.equal(m.soFar, 4998);
});

test('§7.5 projection example: January, the $100 service projects $100.00', () => {
  const m = spendMetrics({ ...example1, today: '2026-01-15' });
  assert.equal(m.committed, 10000 - 833);
  assert.equal(m.runRate, 0, 'every later month is already paid for');
  assert.equal(m.projected, 10000);
});

// §7.5 worked example 2: a $120 annual charge on Aug 10, 2025, still renewing.
const nso = svc({ id: 'n', role: 'keeper', billing_interval: 'annual', price_cents: 12000 });
const nsoCharge2025 = charge({ service_id: 'n', charged_on: '2025-08-10', amount_cents: 12000, billing_interval: 'annual' });

test('§7.5: the Aug 10, 2025 annual charge contributes $10 to each of Jan–Jul 2026 and no 2026 cash', () => {
  const m = spendMetrics({
    services: [nso],
    periods: [period({ service_id: 'n', started_on: '2025-08-10', renews_on: '2026-08-10' })],
    charges: [nsoCharge2025],
    year: 2026,
    today: '2026-06-15',
  });
  assert.deepEqual(m.monthly, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0]);
  assert.equal(m.cash, 0);
});

test('§7.5 projection example: June 2026, the $120 service projects $120.00', () => {
  const m = spendMetrics({
    services: [nso],
    periods: [period({ service_id: 'n', started_on: '2025-08-10', renews_on: '2026-08-10' })],
    charges: [nsoCharge2025],
    year: 2026,
    today: '2026-06-15',
  });
  assert.equal(m.soFar, 6000);
  assert.equal(m.committed, 1000, 'July is prepaid');
  assert.equal(m.runRate, 5 * 1000, 'Aug–Dec at $10/month');
  assert.equal(m.projected, 12000);
});

test('§7.5: after the Aug 10, 2026 renewal is recorded, the projection stays $120 and cash is $120', () => {
  const m = spendMetrics({
    services: [nso],
    periods: [period({ service_id: 'n', started_on: '2025-08-10', renews_on: '2027-08-10' })],
    charges: [nsoCharge2025, charge({ service_id: 'n', charged_on: '2026-08-10', amount_cents: 12000, billing_interval: 'annual', source: 'auto' })],
    year: 2026,
    today: '2026-08-20',
  });
  assert.equal(m.thisMonth, 1000);
  assert.equal(m.soFar, 8000);
  assert.equal(m.cash, 12000);
  assert.equal(m.runRate, 0);
  assert.equal(m.projected, 12000);
});

test('acceptance 11: a $15 monthly charge on Nov 16 counts $15 this month', () => {
  const s = svc({ id: 's', price_cents: 1500 });
  const m = spendMetrics({
    services: [s],
    periods: [period({ service_id: 's', started_on: '2026-11-16', renews_on: '2026-12-16' })],
    charges: [charge({ service_id: 's', charged_on: '2026-11-16', amount_cents: 1500 })],
    year: 2026,
    today: '2026-11-16',
  });
  assert.equal(m.thisMonth, 1500);
  assert.equal(m.committed, 0);
  assert.equal(m.runRate, 1500, 'December is not paid yet');
  assert.equal(m.projected, m.soFar + 1500);
});

test('unknown amounts are excluded from every number', () => {
  const m = spendMetrics({
    services: [],
    periods: [],
    charges: [charge({ charged_on: '2026-11-01', amount_cents: null }), charge({ charged_on: '2026-11-02', amount_cents: 700 })],
    year: 2026,
    today: '2026-11-16',
  });
  assert.equal(m.thisMonth, 700);
  assert.equal(m.cash, 700);
});

test('cancelled services add no run rate', () => {
  const s = svc({ id: 's', price_cents: 1500 });
  const m = spendMetrics({
    services: [s],
    periods: [period({ service_id: 's', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' })],
    charges: [charge({ service_id: 's', charged_on: '2026-11-01', amount_cents: 1500 })],
    year: 2026,
    today: '2026-11-16',
  });
  assert.equal(m.runRate, 0);
  assert.equal(m.projected, m.soFar);
});

test('archived services still count in spend and run rate', () => {
  const s = svc({ id: 's', price_cents: 1500, archived_at: '2026-11-02T00:00:00+00:00' });
  const m = spendMetrics({
    services: [s],
    periods: [period({ service_id: 's', started_on: '2026-11-01', renews_on: '2026-12-01' })],
    charges: [charge({ service_id: 's', charged_on: '2026-11-01', amount_cents: 1500 })],
    year: 2026,
    today: '2026-11-16',
  });
  assert.equal(m.thisMonth, 1500);
  assert.equal(m.runRate, 1500);
});

test('run rate is the monthly equivalent of the current price', () => {
  assert.equal(runRateCents(svc({ billing_interval: 'weekly', price_cents: 300 })), 1300);
  assert.equal(runRateCents(svc({ billing_interval: 'monthly', price_cents: 1500 })), 1500);
  assert.equal(runRateCents(svc({ billing_interval: 'quarterly', price_cents: 3000 })), 1000);
  assert.equal(runRateCents(svc({ billing_interval: 'annual', price_cents: 5000 })), 5000 / 12);
  assert.equal(runRateCents(svc({ price_cents: null })), 0);
});

test('a past year uses M = 12: projection equals the full year', () => {
  const m = spendMetrics({ ...example1, year: 2026, today: '2027-03-01' });
  assert.equal(m.month, 12);
  assert.equal(m.thisMonth, 834, 'December');
  assert.equal(m.soFar, 10000);
  assert.equal(m.average, 10000 / 12);
  assert.equal(m.projected, 10000);
});

test('a future year uses M = 0: so far, average and this month are blank', () => {
  const s = svc({ id: 's', price_cents: 1500 });
  const m = spendMetrics({
    services: [s],
    periods: [period({ service_id: 's', started_on: '2026-11-16', renews_on: '2026-12-16' })],
    charges: [],
    year: 2027,
    today: '2026-11-16',
  });
  assert.equal(m.month, 0);
  assert.equal(m.thisMonth, null);
  assert.equal(m.soFar, null);
  assert.equal(m.average, null);
  assert.equal(m.projected, 12 * 1500);
});
