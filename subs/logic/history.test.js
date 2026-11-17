import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodHistory, chargeTotal } from './history.js';
import { period, charge } from './fixtures.js';

const ids = (rows) => rows.map((r) => r.id);

test('no periods and no charges → empty history', () => {
  assert.deepEqual(periodHistory([], []), { periods: [], loose: [] });
  assert.deepEqual(periodHistory(), { periods: [], loose: [] });
});

test('periods newest first, each with its own charges newest first', () => {
  const mar = period({ id: 'mar', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' });
  const nov = period({ id: 'nov', started_on: '2026-09-16', renews_on: '2026-12-16' });
  const charges = [
    charge({ id: 'c-sep', period_id: 'nov', charged_on: '2026-09-16' }),
    charge({ id: 'c-mar', period_id: 'mar', charged_on: '2026-03-01' }),
    charge({ id: 'c-nov', period_id: 'nov', charged_on: '2026-11-16', source: 'auto' }),
    charge({ id: 'c-oct', period_id: 'nov', charged_on: '2026-10-16', source: 'auto' }),
  ];
  const { periods, loose } = periodHistory([mar, nov], charges);
  assert.deepEqual(periods.map((e) => [e.period.id, e.open, e.accessEndsOn, ids(e.charges)]), [
    ['nov', true, null, ['c-nov', 'c-oct', 'c-sep']],
    ['mar', false, '2026-03-31', ['c-mar']],
  ]);
  assert.deepEqual(loose, []);
});

test('a cancelled period with blank access end uses renews_on − 1 day', () => {
  const p = period({ started_on: '2026-10-20', renews_on: '2026-11-20', cancelled_on: '2026-10-20' });
  assert.equal(periodHistory([p], []).periods[0].accessEndsOn, '2026-11-19');
});

test('charges with no period, or an unknown period, are listed separately', () => {
  const p = period({ id: 'p1', started_on: '2026-11-01', renews_on: '2026-12-01' });
  const charges = [
    charge({ id: 'orphan', period_id: null, charged_on: '2026-01-05' }),
    charge({ id: 'stray', period_id: 'gone', charged_on: '2026-02-05' }),
    charge({ id: 'mine', period_id: 'p1', charged_on: '2026-11-01' }),
  ];
  const { periods, loose } = periodHistory([p], charges);
  assert.deepEqual(ids(periods[0].charges), ['mine']);
  assert.deepEqual(ids(loose), ['stray', 'orphan']);
});

test('a period with no charges has an empty list', () => {
  const p = period({ id: 'p1', started_on: '2026-11-01', renews_on: '2026-12-01' });
  assert.deepEqual(periodHistory([p], []).periods[0].charges, []);
});

test('on the same start date the open period comes first', () => {
  const closed = period({ id: 'closed', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-01' });
  const open = period({ id: 'open', started_on: '2026-11-01', renews_on: '2026-12-01' });
  assert.deepEqual(periodHistory([closed, open], []).periods.map((e) => e.period.id), ['open', 'closed']);
  assert.deepEqual(periodHistory([open, closed], []).periods.map((e) => e.period.id), ['open', 'closed']);
});

test('does not reorder the arrays it was given', () => {
  const a = period({ id: 'a', started_on: '2026-01-01' });
  const b = period({ id: 'b', started_on: '2026-06-01' });
  const input = [a, b];
  periodHistory(input, []);
  assert.deepEqual(ids(input), ['a', 'b']);
});

test('chargeTotal adds known amounts in cents and counts unknown ones', () => {
  const charges = [charge({ amount_cents: 1199 }), charge({ amount_cents: null }), charge({ amount_cents: 1201 })];
  assert.deepEqual(chargeTotal(charges), { cents: 2400, unknown: 1 });
  assert.deepEqual(chargeTotal([]), { cents: 0, unknown: 0 });
});
