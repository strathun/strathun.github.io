import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsFor, dashboardAlerts } from './alerts.js';
import { groupByService } from './status.js';
import { addDays } from './dates.js';
import { svc, period, charge, openBehindCancelled, TODAY } from './fixtures.js';

const types = (alerts) => alerts.map((a) => a.type);
const renewing = (renews_on) => period({ started_on: '2026-11-01', renews_on });
const ending = period({ started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' });

test('a clean service has no alerts', () => {
  assert.deepEqual(alertsFor({ service: svc(), periods: [], charges: [], today: TODAY }), []);
});

test('Cancel now: rotator that is renewing, with its next charge date', () => {
  const alerts = alertsFor({ service: svc({ role: 'rotator' }), periods: [renewing('2026-12-01')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'cancel_now', renewsOn: '2026-12-01', olderStart: null }]);
});

test('Cancel now clears once the rotator is cancelled (acceptance 8)', () => {
  assert.deepEqual(alertsFor({ service: svc({ role: 'rotator' }), periods: [ending], today: TODAY }), []);
});

test('acceptance 13: Decide by appears when the decide-by date is 14 days away', () => {
  // Renews Dec 1, cancel 1 day ahead → decide by Nov 30, 14 days after Nov 16.
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 1 }), periods: [renewing('2026-12-01')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-30', overdue: false, renewsOn: '2026-12-01', olderStart: null }]);
});

test('Decide by does not appear 15 days ahead', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 1 }), periods: [renewing('2026-12-02')], today: TODAY });
  assert.deepEqual(alerts, []);
});

test('Decide by respects cancel_lead_days (Nintendo needs 2)', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 2 }), periods: [renewing('2026-12-02')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-30', overdue: false, renewsOn: '2026-12-02', olderStart: null }]);
});

test('Decide by stays up, marked overdue, after the date passes', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 2 }), periods: [renewing('2026-11-17')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-15', overdue: true, renewsOn: '2026-11-17', olderStart: null }]);
});

test('keepers never get Cancel now, and cancelled keepers get no Decide by', () => {
  assert.deepEqual(alertsFor({ service: svc({ role: 'keeper' }), periods: [ending], today: TODAY }), []);
});

test('Verify link: url_verified is false', () => {
  assert.deepEqual(types(alertsFor({ service: svc({ url_verified: false }), today: TODAY })), ['verify_link']);
});

test('Price unknown replaces Check price when there is no price', () => {
  const alerts = alertsFor({ service: svc({ price_cents: null, price_checked_on: null }), today: TODAY });
  assert.deepEqual(types(alerts), ['price_unknown']);
});

test('Check price: more than 180 days old, but not exactly 180', () => {
  const at180 = svc({ price_checked_on: addDays(TODAY, -180) });
  const at181 = svc({ price_checked_on: addDays(TODAY, -181) });
  assert.deepEqual(alertsFor({ service: at180, today: TODAY }), []);
  assert.deepEqual(alertsFor({ service: at181, today: TODAY }), [{ type: 'check_price', checkedOn: addDays(TODAY, -181) }]);
});

test('Check price: a price that was never checked', () => {
  assert.deepEqual(alertsFor({ service: svc({ price_checked_on: null }), today: TODAY }), [{ type: 'check_price', checkedOn: null }]);
});

test('Amount unknown counts charges with a null amount', () => {
  const charges = [charge({ amount_cents: null }), charge({ amount_cents: 1500 }), charge({ amount_cents: null })];
  assert.deepEqual(alertsFor({ service: svc(), charges, today: TODAY }), [{ type: 'amount_unknown', count: 2 }]);
});

test('archived services show no alerts', () => {
  const service = svc({ role: 'rotator', url_verified: false, price_cents: null, archived_at: '2026-10-01T00:00:00+00:00' });
  const alerts = alertsFor({ service, periods: [renewing('2026-12-01')], charges: [charge({ amount_cents: null })], today: TODAY });
  assert.deepEqual(alerts, []);
});

test('alerts come back in a stable order', () => {
  const service = svc({ role: 'rotator', url_verified: false, price_cents: null });
  const alerts = alertsFor({ service, periods: [renewing('2026-12-01')], charges: [charge({ amount_cents: null })], today: TODAY });
  assert.deepEqual(types(alerts), ['cancel_now', 'verify_link', 'price_unknown', 'amount_unknown']);
});

test('acceptance 19: Cancel now and Decide by follow an older uncancelled period, and name it', () => {
  const periods = openBehindCancelled();
  assert.deepEqual(alertsFor({ service: svc({ role: 'rotator' }), periods, today: TODAY }), [
    { type: 'cancel_now', renewsOn: '2026-12-01', olderStart: '2026-03-01' },
  ]);
  assert.deepEqual(alertsFor({ service: svc({ role: 'keeper' }), periods, today: TODAY }), [
    { type: 'decide_by', date: '2026-11-30', overdue: false, renewsOn: '2026-12-01', olderStart: '2026-03-01' },
  ]);
});

test('a keeper with an older open period gets Decide by however far off the date is', () => {
  // Annual: the Mar 2025 backfill was caught up to Mar 2027, months outside the 14-day window.
  const periods = [
    period({ started_on: '2025-03-01', renews_on: '2027-03-01' }),
    period({ started_on: '2026-06-01', renews_on: '2027-06-01', cancelled_on: '2026-06-01', access_ends_on: '2026-06-30' }),
  ];
  const alerts = alertsFor({ service: svc({ role: 'keeper', billing_interval: 'annual' }), periods, today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2027-02-28', overdue: false, renewsOn: '2027-03-01', olderStart: '2025-03-01' }]);
});

test('olderStart stays null for an open period sharing the latest start date', () => {
  const twin = period({ started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' });
  const alerts = alertsFor({ service: svc({ role: 'rotator' }), periods: [twin, renewing('2026-12-01')], today: TODAY });
  assert.equal(alerts[0].olderStart, null);
});

test('Cancel now with no renews_on still shows, with no date', () => {
  const alerts = alertsFor({ service: svc({ role: 'rotator' }), periods: [period({ started_on: '2026-11-01' })], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'cancel_now', renewsOn: null, olderStart: null }]);
});

// ── the dashboard Alerts list (SPEC §8.1) ───────────────────────────────────

const list = (services, periods = [], charges = []) =>
  dashboardAlerts({ services, periodsByService: groupByService(periods), chargesByService: groupByService(charges), today: TODAY })
    .map(({ service, alert }) => `${alert.type}:${service.name}`);
const open = (service_id, renews_on) => period({ service_id, started_on: '2026-11-01', renews_on });

test('dashboard list: only Cancel now, Decide by and Amount unknown; badges stay on the rows', () => {
  const s = svc({ id: 'a', name: 'A', url_verified: false, price_cents: null });
  assert.deepEqual(list([s], [open('a', '2026-12-01')], [charge({ service_id: 'a', amount_cents: null })]), [
    'cancel_now:A', 'amount_unknown:A',
  ]);
});

test('dashboard list: Cancel now, then Decide by, then Amount unknown', () => {
  const services = [
    svc({ id: 'u', name: 'Unknown' }),
    svc({ id: 'k', name: 'Keeper', role: 'keeper' }),
    svc({ id: 'r', name: 'Rotator' }),
  ];
  const periods = [open('k', '2026-11-20'), open('r', '2026-12-10')];
  assert.deepEqual(list(services, periods, [charge({ service_id: 'u', amount_cents: null })]), [
    'cancel_now:Rotator', 'decide_by:Keeper', 'amount_unknown:Unknown',
  ]);
});

test('dashboard list: Cancel now by next charge, then name; no date goes last', () => {
  const services = [
    svc({ id: 'a', name: 'apple' }), svc({ id: 'b', name: 'Bravo' }),
    svc({ id: 'c', name: 'Charlie' }), svc({ id: 'd', name: 'Delta' }),
  ];
  const periods = [open('a', '2026-12-10'), open('b', '2026-11-20'), open('c', '2026-12-10'), period({ service_id: 'd', started_on: '2026-11-01' })];
  assert.deepEqual(list(services, periods), ['cancel_now:Bravo', 'cancel_now:apple', 'cancel_now:Charlie', 'cancel_now:Delta']);
});

test('dashboard list: Decide by by date, so a passed one comes first', () => {
  const services = [svc({ id: 'x', name: 'Later', role: 'keeper' }), svc({ id: 'y', name: 'Passed', role: 'keeper' })];
  const periods = [open('x', '2026-11-25'), open('y', '2026-11-16')];
  assert.deepEqual(list(services, periods), ['decide_by:Passed', 'decide_by:Later']);
});

test('dashboard list: Amount unknown by name, one entry per service with its count', () => {
  const services = [svc({ id: 'z', name: 'Zed' }), svc({ id: 'm', name: 'mid' })];
  const charges = [charge({ service_id: 'z', amount_cents: null }), charge({ service_id: 'm', amount_cents: null }), charge({ service_id: 'm', amount_cents: null })];
  const got = dashboardAlerts({ services, periodsByService: new Map(), chargesByService: groupByService(charges), today: TODAY });
  assert.deepEqual(got.map((e) => [e.service.name, e.alert.count]), [['mid', 2], ['Zed', 1]]);
});

test('dashboard list: archived services are left out, even when renewing', () => {
  const s = svc({ id: 'a', name: 'A', archived_at: '2026-10-01T00:00:00+00:00' });
  assert.deepEqual(list([s], [open('a', '2026-12-01')], [charge({ service_id: 'a', amount_cents: null })]), []);
});

test('dashboard list: empty when nothing needs attention', () => {
  assert.deepEqual(list([svc({ id: 'a' })], []), []);
  assert.deepEqual(list([], []), []);
});
