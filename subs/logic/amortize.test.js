import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageMonths, sliceCharge, slicesInYear, monthlyTotals } from './amortize.js';
import { charge } from './fixtures.js';

const sum = (slices) => slices.reduce((t, s) => t + s.cents, 0);

test('coverage months per interval (§7.4 table)', () => {
  assert.equal(coverageMonths('weekly'), 1);
  assert.equal(coverageMonths('monthly'), 1);
  assert.equal(coverageMonths('quarterly'), 3);
  assert.equal(coverageMonths('annual'), 12);
  assert.throws(() => coverageMonths('yearly'));
});

test('acceptance 11: a $15 monthly charge on Nov 16 counts $15 in November', () => {
  const slices = sliceCharge(charge({ charged_on: '2026-11-16', amount_cents: 1500 }));
  assert.deepEqual(slices, [{ month: '2026-11', cents: 1500 }]);
});

test('weekly charges count whole in the month charged', () => {
  const slices = sliceCharge(charge({ charged_on: '2026-11-30', amount_cents: 299, billing_interval: 'weekly' }));
  assert.deepEqual(slices, [{ month: '2026-11', cents: 299 }]);
});

test('§7.4 example: $100 annual is 833¢ × 8 then 834¢ × 4, summing to 10000', () => {
  const slices = sliceCharge(charge({ charged_on: '2026-01-01', amount_cents: 10000, billing_interval: 'annual' }));
  assert.equal(slices.length, 12);
  assert.deepEqual(slices.map((s) => s.cents), [833, 833, 833, 833, 833, 833, 833, 833, 834, 834, 834, 834]);
  assert.equal(slices[0].month, '2026-01');
  assert.equal(slices[11].month, '2026-12');
  assert.equal(sum(slices), 10000);
});

test('quarterly remainder goes to the latest month', () => {
  const slices = sliceCharge(charge({ charged_on: '2026-11-30', amount_cents: 1000, billing_interval: 'quarterly' }));
  assert.deepEqual(slices, [
    { month: '2026-11', cents: 333 },
    { month: '2026-12', cents: 333 },
    { month: '2027-01', cents: 334 },
  ]);
});

test('amounts smaller than the month count still sum exactly', () => {
  const slices = sliceCharge(charge({ amount_cents: 5, billing_interval: 'annual' }));
  assert.deepEqual(slices.map((s) => s.cents), [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.equal(sum(slices), 5);
});

test('an annual charge on Aug 10, 2025 covers Aug 2025 through Jul 2026', () => {
  const slices = sliceCharge(charge({ charged_on: '2025-08-10', amount_cents: 12000, billing_interval: 'annual' }));
  assert.equal(slices[0].month, '2025-08');
  assert.equal(slices[11].month, '2026-07');
  assert.ok(slices.every((s) => s.cents === 1000));
});

test('unknown amounts produce no slices', () => {
  assert.deepEqual(sliceCharge(charge({ amount_cents: null })), []);
});

test('slicesInYear groups by service and keeps only the selected year', () => {
  const byService = slicesInYear([
    charge({ service_id: 'a', charged_on: '2025-08-10', amount_cents: 12000, billing_interval: 'annual' }),
    charge({ service_id: 'b', charged_on: '2026-11-16', amount_cents: 1500 }),
    charge({ service_id: 'b', charged_on: '2026-11-20', amount_cents: 500 }),
    charge({ service_id: 'c', charged_on: '2026-03-01', amount_cents: null }),
  ], 2026);

  assert.deepEqual(byService.get('a'), [1000, 1000, 1000, 1000, 1000, 1000, 1000, null, null, null, null, null]);
  assert.deepEqual(byService.get('b'), [null, null, null, null, null, null, null, null, null, null, 2000, null]);
  assert.equal(byService.has('c'), false, 'a charge with no slices adds no row');
});

test('monthlyTotals sums every service per month, treating empty as 0', () => {
  const totals = monthlyTotals(slicesInYear([
    charge({ service_id: 'a', charged_on: '2026-01-01', amount_cents: 10000, billing_interval: 'annual' }),
    charge({ service_id: 'b', charged_on: '2026-11-16', amount_cents: 1500 }),
  ], 2026));
  assert.equal(totals.length, 12);
  assert.equal(totals[0], 833);
  assert.equal(totals[10], 834 + 1500);
  assert.equal(totals.reduce((a, b) => a + b, 0), 10000 + 1500);
});
