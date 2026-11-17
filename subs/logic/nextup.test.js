import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextUp } from './nextup.js';
import { svc, period, item, openBehindCancelled, TODAY } from './fixtures.js';

const pick = (input) => nextUp({ periods: [], watchlist: [], today: TODAY, ...input })?.service.id ?? null;

test('picks the inactive rotator with the most open watchlist items', () => {
  const services = [svc({ id: 'a', name: 'A' }), svc({ id: 'b', name: 'B' })];
  const watchlist = [item({ service_id: 'a' }), item({ service_id: 'b' }), item({ service_id: 'b' })];
  assert.equal(pick({ services, watchlist }), 'b');
  assert.deepEqual(nextUp({ services, periods: [], watchlist, today: TODAY }), {
    service: services[1], openCount: 2, earliestAvailableFrom: null,
  });
});

test('done items do not count', () => {
  const services = [svc({ id: 'a', name: 'A' }), svc({ id: 'b', name: 'B' })];
  const watchlist = [
    item({ service_id: 'a' }),
    item({ service_id: 'b', done_at: '2026-10-01T00:00:00+00:00' }),
    item({ service_id: 'b', done_at: '2026-10-02T00:00:00+00:00' }),
  ];
  assert.equal(pick({ services, watchlist }), 'a');
});

test('only inactive, non-archived rotators are candidates', () => {
  const services = [
    svc({ id: 'renewing' }),
    svc({ id: 'ending' }),
    svc({ id: 'keeper', role: 'keeper' }),
    svc({ id: 'archived', archived_at: '2026-10-01T00:00:00+00:00' }),
    svc({ id: 'ok', name: 'OK' }),
  ];
  const periods = [
    period({ service_id: 'renewing', started_on: '2026-11-01', renews_on: '2026-12-01' }),
    period({ service_id: 'ending', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' }),
    period({ service_id: 'ok', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' }),
  ];
  const watchlist = [
    ...['renewing', 'ending', 'keeper', 'archived'].flatMap((id) => [item({ service_id: id }), item({ service_id: id })]),
    item({ service_id: 'ok' }),
  ];
  assert.equal(pick({ services, periods, watchlist }), 'ok');
});

test('no open items anywhere → null', () => {
  assert.equal(nextUp({ services: [svc()], periods: [], watchlist: [], today: TODAY }), null);
  assert.equal(nextUp({ services: [], periods: [], watchlist: [], today: TODAY }), null);
});

test('ties go to the earliest available_from among open items', () => {
  const services = [svc({ id: 'a', name: 'A' }), svc({ id: 'b', name: 'B' })];
  const watchlist = [
    item({ service_id: 'a', available_from: '2026-12-01' }),
    item({ service_id: 'a', available_from: '2027-03-01' }),
    item({ service_id: 'b', available_from: '2027-01-15' }),
    item({ service_id: 'b', available_from: '2026-11-20' }),
  ];
  assert.equal(pick({ services, watchlist }), 'b');
});

test('a blank available_from means available now and wins the tie', () => {
  const services = [svc({ id: 'a', name: 'A' }), svc({ id: 'b', name: 'B' })];
  const watchlist = [item({ service_id: 'a', available_from: '2026-01-01' }), item({ service_id: 'b', available_from: null })];
  assert.equal(pick({ services, watchlist }), 'b');
});

test('remaining ties go by name', () => {
  const services = [svc({ id: 'z', name: 'Zeta' }), svc({ id: 'a', name: 'alpha' })];
  const watchlist = [item({ service_id: 'z' }), item({ service_id: 'a' })];
  assert.equal(pick({ services, watchlist }), 'a');
});

test('a rotator with an older uncancelled period is still billing, so it is not next up', () => {
  const services = [svc({ id: 'a', name: 'A' })];
  assert.equal(pick({ services, watchlist: [item({ service_id: 'a' })], periods: openBehindCancelled('a') }), null);
});
