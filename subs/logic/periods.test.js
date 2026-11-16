import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSubscribe, planCancel, nextRenewal, planCatchUp, planCatchUpAll } from './periods.js';
import { svc, period, TODAY } from './fixtures.js';

// ── Mark subscribed ─────────────────────────────────────────────────────────

test('planSubscribe creates a period renewing one interval later and a manual charge', () => {
  const s = svc({ id: 'netflix', billing_interval: 'monthly', price_cents: 1799 });
  assert.deepEqual(planSubscribe(s, TODAY), {
    period: { service_id: 'netflix', started_on: '2026-11-16', renews_on: '2026-12-16' },
    charge: { service_id: 'netflix', charged_on: '2026-11-16', amount_cents: 1799, billing_interval: 'monthly', source: 'manual' },
  });
});

test('planSubscribe with an unknown price records a charge with an unknown amount', () => {
  assert.equal(planSubscribe(svc({ price_cents: null }), TODAY).charge.amount_cents, null);
});

test('planSubscribe backfills an annual subscription', () => {
  const plan = planSubscribe(svc({ billing_interval: 'annual', price_cents: 12000 }), '2025-08-10');
  assert.equal(plan.period.renews_on, '2026-08-10');
  assert.equal(plan.charge.billing_interval, 'annual');
});

// ── Mark cancelled ──────────────────────────────────────────────────────────

test('planCancel defaults access_ends_on to renews_on − 1 day', () => {
  const p = period({ started_on: TODAY, renews_on: '2026-12-16' });
  assert.deepEqual(planCancel(p, TODAY), { cancelled_on: TODAY, access_ends_on: '2026-12-15' });
});

test('planCancel keeps an edited access_ends_on', () => {
  const p = period({ started_on: TODAY, renews_on: '2026-12-16' });
  assert.deepEqual(planCancel(p, TODAY, '2026-12-16'), { cancelled_on: TODAY, access_ends_on: '2026-12-16' });
});

test('planCancel refuses a period that is already cancelled', () => {
  const p = period({ started_on: TODAY, renews_on: '2026-12-16', cancelled_on: TODAY, access_ends_on: '2026-12-15' });
  assert.throws(() => planCancel(p, TODAY), /already cancelled/);
});

// ── Renewal day ─────────────────────────────────────────────────────────────

test('nextRenewal returns month-end starts to their day instead of drifting', () => {
  const seq = [];
  let p = period({ started_on: '2026-01-31', renews_on: '2026-02-28' });
  for (let i = 0; i < 3; i++) {
    const next = nextRenewal(p, 'monthly');
    seq.push(next);
    p = { ...p, renews_on: next };
  }
  assert.deepEqual(seq, ['2026-03-31', '2026-04-30', '2026-05-31']);
});

test('nextRenewal: a Jan 30 start clamped to Feb 28 returns to the 30th', () => {
  assert.equal(nextRenewal(period({ started_on: '2026-01-30', renews_on: '2026-02-28' }), 'monthly'), '2026-03-30');
});

test('nextRenewal: an edited renews_on day becomes the renewal day', () => {
  assert.equal(nextRenewal(period({ started_on: '2026-01-15', renews_on: '2026-02-05' }), 'monthly'), '2026-03-05');
});

test('nextRenewal: annual Feb 29 start renews Feb 28, then Feb 29 in leap years', () => {
  assert.equal(nextRenewal(period({ started_on: '2028-02-29', renews_on: '2029-02-28' }), 'annual'), '2030-02-28');
  assert.equal(nextRenewal(period({ started_on: '2028-02-29', renews_on: '2031-02-28' }), 'annual'), '2032-02-29');
});

test('nextRenewal: weekly adds 7 days and quarterly adds 3 months', () => {
  assert.equal(nextRenewal(period({ started_on: '2026-12-21', renews_on: '2026-12-28' }), 'weekly'), '2027-01-04');
  assert.equal(nextRenewal(period({ started_on: '2026-08-31', renews_on: '2026-11-30' }), 'quarterly'), '2027-02-28');
});

// ── Automatic renewal catch-up ──────────────────────────────────────────────

const monthly = svc({ id: 'spotify', role: 'keeper', billing_interval: 'monthly', price_cents: 1199 });

test('catch-up does nothing before the renewal date', () => {
  const p = period({ id: 'p1', service_id: 'spotify', started_on: '2026-11-10', renews_on: '2026-12-10' });
  assert.deepEqual(planCatchUp(p, monthly, TODAY), { charges: [], renews_on: '2026-12-10' });
});

test('catch-up charges a renewal dated today (renews_on <= today)', () => {
  const p = period({ id: 'p1', service_id: 'spotify', started_on: '2026-10-16', renews_on: TODAY });
  assert.deepEqual(planCatchUp(p, monthly, TODAY), {
    charges: [{
      service_id: 'spotify', period_id: 'p1', charged_on: TODAY,
      amount_cents: 1199, billing_interval: 'monthly', source: 'auto',
    }],
    renews_on: '2026-12-16',
  });
});

test('acceptance 6: a backfilled subscription gets every missed renewal', () => {
  const plan = planSubscribe(monthly, '2026-08-16');
  const p = { id: 'p1', ...plan.period, cancelled_on: null, access_ends_on: null };
  const result = planCatchUp(p, monthly, TODAY);
  assert.deepEqual(result.charges.map((c) => c.charged_on), ['2026-09-16', '2026-10-16', '2026-11-16']);
  assert.ok(result.charges.every((c) => c.source === 'auto' && c.amount_cents === 1199));
  assert.equal(result.renews_on, '2026-12-16');
});

test('acceptance 9: catch-up is idempotent and deterministic', () => {
  const p = period({ id: 'p1', service_id: 'spotify', started_on: '2026-08-16', renews_on: '2026-09-16' });
  const first = planCatchUp(p, monthly, TODAY);
  // Two tabs computing from the same rows produce identical inserts (the unique index dedupes them).
  assert.deepEqual(planCatchUp(p, monthly, TODAY), first);
  // After applying the result, a reload finds nothing to do.
  assert.deepEqual(planCatchUp({ ...p, renews_on: first.renews_on }, monthly, TODAY).charges, []);
});

test('§7.5: the $120 Aug 10, 2025 annual renews on Aug 10, 2026', () => {
  const annual = svc({ id: 'nso', billing_interval: 'annual', price_cents: 12000 });
  const p = period({ id: 'p1', service_id: 'nso', started_on: '2025-08-10', renews_on: '2026-08-10' });
  const result = planCatchUp(p, annual, '2026-08-10');
  assert.deepEqual(result.charges.map((c) => [c.charged_on, c.amount_cents, c.billing_interval]), [['2026-08-10', 12000, 'annual']]);
  assert.equal(result.renews_on, '2027-08-10');
});

test('catch-up keeps month-end renewals on their day', () => {
  const p = period({ id: 'p1', service_id: 'spotify', started_on: '2026-01-31', renews_on: '2026-02-28' });
  const result = planCatchUp(p, monthly, '2026-04-30');
  assert.deepEqual(result.charges.map((c) => c.charged_on), ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(result.renews_on, '2026-05-31');
});

test('catch-up skips cancelled periods', () => {
  const p = period({ id: 'p1', started_on: '2026-08-16', renews_on: '2026-09-16', cancelled_on: '2026-08-16', access_ends_on: '2026-09-15' });
  assert.deepEqual(planCatchUp(p, monthly, TODAY).charges, []);
});

test('catch-up uses the current price and snapshots the interval; unknown price stays unknown', () => {
  const p = period({ id: 'p1', service_id: 'x', started_on: '2026-10-16', renews_on: TODAY });
  const [c] = planCatchUp(p, svc({ billing_interval: 'monthly', price_cents: null }), TODAY).charges;
  assert.equal(c.amount_cents, null);
  assert.equal(c.billing_interval, 'monthly');
});

test('catch-up refuses to generate an implausible number of charges', () => {
  const p = period({ id: 'p1', started_on: '2000-01-01', renews_on: '2000-01-08' });
  assert.throws(() => planCatchUp(p, svc({ billing_interval: 'weekly' }), TODAY), /more than/);
});

test('planCatchUpAll returns work only for due, uncancelled periods (archived included)', () => {
  const a = svc({ id: 'a', price_cents: 1000 });
  const b = svc({ id: 'b', price_cents: 2000, archived_at: '2026-10-01T00:00:00+00:00' });
  const c = svc({ id: 'c' });
  const periods = [
    period({ id: 'pa', service_id: 'a', started_on: '2026-10-16', renews_on: TODAY }),
    period({ id: 'pb', service_id: 'b', started_on: '2026-09-01', renews_on: '2026-10-01' }),
    period({ id: 'pc', service_id: 'c', started_on: '2026-11-10', renews_on: '2026-12-10' }),
    period({ id: 'pd', service_id: 'c', started_on: '2026-05-01', renews_on: '2026-06-01', cancelled_on: '2026-05-01', access_ends_on: '2026-05-31' }),
  ];
  const work = planCatchUpAll({ services: [a, b, c], periods, today: TODAY });
  assert.deepEqual(work.map((w) => [w.period_id, w.renews_on, w.charges.length]), [
    ['pa', '2026-12-16', 1],
    ['pb', '2026-12-01', 2],
  ]);
});
