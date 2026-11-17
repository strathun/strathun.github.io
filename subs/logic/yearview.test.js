import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearView, yearRange, clampYear } from './yearview.js';
import { spendMetrics } from './spend.js';
import { svc, period, charge, TODAY } from './fixtures.js';

const row = (view, id) => view.rows.find((r) => r.service.id === id);
const activeMonths = (r) => r.cells.filter((c) => c.active).map((c) => c.month);

test('rows: active in the year, slice-only, and archived services are included; others are not', () => {
  const services = [
    svc({ id: 'active' }),
    svc({ id: 'slice-only', billing_interval: 'annual' }),
    svc({ id: 'archived', archived_at: '2026-06-01T00:00:00+00:00' }),
    svc({ id: 'last-year' }),
    svc({ id: 'never' }),
  ];
  const periods = [
    period({ service_id: 'active', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' }),
    period({ service_id: 'archived', started_on: '2026-02-01', renews_on: '2026-03-01', cancelled_on: '2026-02-01', access_ends_on: '2026-02-28' }),
    period({ service_id: 'last-year', started_on: '2025-03-01', renews_on: '2025-04-01', cancelled_on: '2025-03-01', access_ends_on: '2025-03-31' }),
  ];
  // A charge whose period was deleted (period_id set null) still has slices.
  const charges = [charge({ service_id: 'slice-only', charged_on: '2025-10-01', amount_cents: 12000, billing_interval: 'annual' })];

  const view = yearView({ services, periods, charges, year: 2026, today: TODAY });
  assert.deepEqual(view.rows.map((r) => r.service.id), ['active', 'slice-only', 'archived']);
  assert.deepEqual(activeMonths(row(view, 'slice-only')), []);
  assert.equal(row(view, 'slice-only').cells[8].cents, 1000, 'September 2026');
  assert.equal(row(view, 'slice-only').cells[9].cents, null, 'October 2026 is past its coverage');
});

test('active: the access window overlaps the month, inclusive at both ends', () => {
  const s = svc({ id: 's' });
  const periods = [
    period({ service_id: 's', started_on: '2026-01-31', renews_on: '2026-02-28', cancelled_on: '2026-01-31', access_ends_on: '2026-02-01' }),
    period({ service_id: 's', started_on: '2026-04-30', renews_on: '2026-05-30', cancelled_on: '2026-04-30', access_ends_on: '2026-06-01' }),
  ];
  const view = yearView({ services: [s], periods, charges: [], year: 2026, today: TODAY });
  assert.deepEqual(activeMonths(row(view, 's')), [1, 2, 4, 5, 6]);
});

test('active: a blank access_ends_on uses renews_on − 1 day', () => {
  const s = svc({ id: 's' });
  const periods = [period({ service_id: 's', started_on: '2026-02-15', renews_on: '2026-03-01', cancelled_on: '2026-02-15' })];
  const view = yearView({ services: [s], periods, charges: [], year: 2026, today: TODAY });
  assert.deepEqual(activeMonths(row(view, 's')), [2]);
});

test('a renewing period is active through today; later months are future and never active', () => {
  const s = svc({ id: 's' });
  const periods = [period({ service_id: 's', started_on: '2026-09-05', renews_on: '2026-12-05' })];
  const view = yearView({ services: [s], periods, charges: [], year: 2026, today: TODAY });
  const r = row(view, 's');
  assert.deepEqual(activeMonths(r), [9, 10, 11]);
  assert.equal(r.cells[11].future, true);
  assert.equal(r.cells[10].future, false);
});

test('future months show committed slices only, even if access runs into them', () => {
  const s = svc({ id: 's', billing_interval: 'quarterly' });
  const periods = [period({ service_id: 's', started_on: '2026-11-01', renews_on: '2027-02-01', cancelled_on: '2026-11-01', access_ends_on: '2027-01-31' })];
  const charges = [charge({ service_id: 's', charged_on: '2026-11-01', amount_cents: 3000, billing_interval: 'quarterly' })];
  const view = yearView({ services: [s], periods, charges, year: 2026, today: TODAY });
  const dec = row(view, 's').cells[11];
  assert.deepEqual(dec, { month: 12, active: false, cents: 1000, future: true });
});

test('past years have no future months; future years are all future', () => {
  const s = svc({ id: 's' });
  const periods = [period({ service_id: 's', started_on: '2025-01-10', renews_on: '2027-01-10' })];
  const past = yearView({ services: [s], periods, charges: [], year: 2025, today: TODAY });
  assert.ok(row(past, 's').cells.every((c) => !c.future && c.active));
  const future = yearView({ services: [s], periods, charges: [], year: 2027, today: TODAY });
  assert.deepEqual(future.rows, [], 'no slices and nothing active yet');
});

test('acceptance 12: the totals row matches This month (and every monthly total)', () => {
  const services = [
    svc({ id: 'annual', role: 'keeper', billing_interval: 'annual', price_cents: 10000 }),
    svc({ id: 'monthly', price_cents: 1500 }),
    svc({ id: 'gone', archived_at: '2026-05-01T00:00:00+00:00', price_cents: 999 }),
  ];
  const periods = [
    period({ service_id: 'annual', started_on: '2026-01-01', renews_on: '2027-01-01' }),
    period({ service_id: 'monthly', started_on: '2026-10-16', renews_on: '2026-12-16' }),
    period({ service_id: 'gone', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' }),
  ];
  const charges = [
    charge({ service_id: 'annual', charged_on: '2026-01-01', amount_cents: 10000, billing_interval: 'annual' }),
    charge({ service_id: 'monthly', charged_on: '2026-10-16', amount_cents: 1500 }),
    charge({ service_id: 'monthly', charged_on: '2026-11-16', amount_cents: 1500, source: 'auto' }),
    charge({ service_id: 'gone', charged_on: '2026-03-01', amount_cents: 999 }),
  ];
  const input = { services, periods, charges, year: 2026, today: TODAY };
  const view = yearView(input);
  const spend = spendMetrics(input);
  assert.equal(view.totals[10], spend.thisMonth);
  assert.equal(view.totals[10], 834 + 1500);
  assert.deepEqual(view.totals, spend.monthly);
});

test('rows are sorted by name, case-insensitively, archived ones in place (SPEC §8.2)', () => {
  const services = [
    svc({ id: 'z', name: 'zulu' }),
    svc({ id: 'a', name: 'Alpha', archived_at: '2026-06-01T00:00:00+00:00' }),
    svc({ id: 'm', name: 'mike' }),
  ];
  const periods = services.map((s) => period({ service_id: s.id, started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' }));
  const view = yearView({ services, periods, charges: [], year: 2026, today: TODAY });
  assert.deepEqual(view.rows.map((r) => r.service.id), ['a', 'm', 'z']);
});

test('yearRange: the first year with a period or charge, through next year', () => {
  assert.deepEqual(yearRange({ periods: [], charges: [], today: TODAY }), { first: 2026, last: 2027 }, 'no data: this year and next');
  const range = yearRange({
    periods: [period({ started_on: '2025-12-05' })],
    // a charge whose period was deleted can be the oldest row
    charges: [charge({ charged_on: '2024-08-10' }), charge({ charged_on: '2026-01-01' })],
    today: TODAY,
  });
  assert.deepEqual(range, { first: 2024, last: 2027 });
});

test('clampYear: a year outside the range shows the nearest one (acceptance 22)', () => {
  const range = { first: 2025, last: 2027 };
  assert.equal(clampYear(1999, range), 2025);
  assert.equal(clampYear(2026, range), 2026);
  assert.equal(clampYear(2027, range), 2027);
  assert.equal(clampYear(3000, range), 2027);
});
