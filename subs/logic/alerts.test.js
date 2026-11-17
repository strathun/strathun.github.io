import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsFor } from './alerts.js';
import { addDays } from './dates.js';
import { svc, period, charge, openBehindCancelled, TODAY } from './fixtures.js';

const types = (alerts) => alerts.map((a) => a.type);
const renewing = (renews_on) => period({ started_on: '2026-11-01', renews_on });
const ending = period({ started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: '2026-11-01', access_ends_on: '2026-11-30' });

test('a clean service has no alerts', () => {
  assert.deepEqual(alertsFor({ service: svc(), periods: [], charges: [], today: TODAY }), []);
});

test('Cancel now: rotator that is renewing', () => {
  const alerts = alertsFor({ service: svc({ role: 'rotator' }), periods: [renewing('2026-12-01')], today: TODAY });
  assert.deepEqual(types(alerts), ['cancel_now']);
});

test('Cancel now clears once the rotator is cancelled (acceptance 8)', () => {
  assert.deepEqual(alertsFor({ service: svc({ role: 'rotator' }), periods: [ending], today: TODAY }), []);
});

test('acceptance 13: Decide by appears when the decide-by date is 14 days away', () => {
  // Renews Dec 1, cancel 1 day ahead → decide by Nov 30, 14 days after Nov 16.
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 1 }), periods: [renewing('2026-12-01')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-30', overdue: false }]);
});

test('Decide by does not appear 15 days ahead', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 1 }), periods: [renewing('2026-12-02')], today: TODAY });
  assert.deepEqual(alerts, []);
});

test('Decide by respects cancel_lead_days (Nintendo needs 2)', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 2 }), periods: [renewing('2026-12-02')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-30', overdue: false }]);
});

test('Decide by stays up, marked overdue, after the date passes', () => {
  const alerts = alertsFor({ service: svc({ role: 'keeper', cancel_lead_days: 2 }), periods: [renewing('2026-11-17')], today: TODAY });
  assert.deepEqual(alerts, [{ type: 'decide_by', date: '2026-11-15', overdue: true }]);
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

test('acceptance 19: Cancel now and Decide by follow an older uncancelled period', () => {
  const periods = openBehindCancelled();
  assert.deepEqual(types(alertsFor({ service: svc({ role: 'rotator' }), periods, today: TODAY })), ['cancel_now']);
  assert.deepEqual(types(alertsFor({ service: svc({ role: 'keeper' }), periods, today: TODAY })), ['decide_by']);
});
