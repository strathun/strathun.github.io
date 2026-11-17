import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceStatus, latestPeriod, accessEnd, groupByService, openPeriod } from './status.js';
import { period, TODAY } from './fixtures.js';

test('no periods → inactive', () => {
  assert.deepEqual(serviceStatus([], TODAY), { status: 'inactive', period: null, accessEndsOn: null });
});

test('uncancelled latest period → renewing', () => {
  const p = period({ started_on: '2026-11-01', renews_on: '2026-12-01' });
  const s = serviceStatus([p], TODAY);
  assert.equal(s.status, 'renewing');
  assert.equal(s.period, p);
  assert.equal(s.accessEndsOn, null);
});

test('cancelled with access ending today → ending (inclusive)', () => {
  const p = period({ started_on: '2026-10-16', renews_on: '2026-11-16', cancelled_on: '2026-10-16', access_ends_on: TODAY });
  assert.deepEqual(serviceStatus([p], TODAY), { status: 'ending', period: p, accessEndsOn: TODAY });
});

test('acceptance 8: the day after access_ends_on → inactive', () => {
  const p = period({ started_on: '2026-10-16', renews_on: '2026-11-16', cancelled_on: '2026-10-16', access_ends_on: '2026-11-15' });
  assert.equal(serviceStatus([p], TODAY).status, 'inactive');
  assert.equal(serviceStatus([p], TODAY).accessEndsOn, '2026-11-15');
});

test('blank access_ends_on falls back to renews_on − 1 day', () => {
  const p = period({ started_on: '2026-10-20', renews_on: '2026-11-20', cancelled_on: '2026-10-20' });
  assert.equal(accessEnd(p), '2026-11-19');
  assert.deepEqual(serviceStatus([p], TODAY), { status: 'ending', period: p, accessEndsOn: '2026-11-19' });
});

test('blank access_ends_on and renews_on fall back to cancelled_on', () => {
  assert.equal(accessEnd(period({ started_on: '2026-10-01', cancelled_on: '2026-10-05' })), '2026-10-05');
});

test('accessEnd is null for an uncancelled period', () => {
  assert.equal(accessEnd(period({ renews_on: '2026-12-01' })), null);
});

test('latest period is the one with the latest started_on, in any input order', () => {
  const old = period({ started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' });
  const current = period({ started_on: '2026-11-10', renews_on: '2026-12-10' });
  assert.equal(latestPeriod([current, old]), current);
  assert.equal(latestPeriod([old, current]), current);
  assert.equal(serviceStatus([old, current], TODAY).status, 'renewing');
});

test('a past rotation alone leaves the service inactive', () => {
  const old = period({ started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' });
  assert.equal(serviceStatus([old], TODAY).status, 'inactive');
});

test('same started_on: the uncancelled period wins', () => {
  const cancelled = period({ started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' });
  const open = period({ started_on: '2026-11-01', renews_on: '2026-12-01' });
  assert.equal(latestPeriod([open, cancelled]), open);
  assert.equal(latestPeriod([cancelled, open]), open);
});

test('groupByService buckets rows by service_id', () => {
  const rows = [{ service_id: 'a', n: 1 }, { service_id: 'b', n: 2 }, { service_id: 'a', n: 3 }];
  const map = groupByService(rows);
  assert.deepEqual(map.get('a').map((r) => r.n), [1, 3]);
  assert.deepEqual(map.get('b').map((r) => r.n), [2]);
  assert.equal(map.get('c'), undefined);
});

test('openPeriod finds the uncancelled period, even when it is not the latest', () => {
  const open = period({ started_on: '2026-03-01', renews_on: '2026-04-01' });
  const later = period({ started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' });
  assert.equal(openPeriod([later, open]), open);
  assert.equal(openPeriod([later]), null);
  assert.equal(openPeriod([]), null);
});
