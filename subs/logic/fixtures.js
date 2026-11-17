// Test-only row builders shaped like Supabase rows (SPEC §6).
// Not named test-*.js on purpose: node --test would run that as a test file.
// Defaults describe a "clean" service with no alerts on TODAY.

export const TODAY = '2026-11-16';

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

export function svc(over = {}) {
  return {
    id: nextId('svc'),
    name: 'Service',
    category: 'video',
    role: 'rotator',
    billing_interval: 'monthly',
    price_cents: 1500,
    price_checked_on: '2026-11-01',
    manage_url: 'https://example.com/account',
    manage_path: null,
    help_url: null,
    url_verified: true,
    cancel_lead_days: 1,
    notes: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    ...over,
  };
}

export function period(over = {}) {
  return {
    id: nextId('per'),
    service_id: 'svc-x',
    started_on: '2026-11-01',
    renews_on: null,
    cancelled_on: null,
    access_ends_on: null,
    ...over,
  };
}

/**
 * SPEC §7.1, acceptance 19: a Mar 1 backfill left uncancelled (caught up to a
 * Dec 1 renewal) behind a June rotation that was cancelled. Returns [open, later].
 */
export function openBehindCancelled(service_id = 'svc-x') {
  return [
    period({ service_id, started_on: '2026-03-01', renews_on: '2026-12-01' }),
    period({ service_id, started_on: '2026-06-01', renews_on: '2026-07-01', cancelled_on: '2026-06-01', access_ends_on: '2026-06-30' }),
  ];
}

export function charge(over = {}) {
  return {
    id: nextId('chg'),
    service_id: 'svc-x',
    period_id: null,
    charged_on: '2026-11-01',
    amount_cents: 1500,
    billing_interval: 'monthly',
    source: 'manual',
    ...over,
  };
}

export function item(over = {}) {
  return {
    id: nextId('itm'),
    service_id: 'svc-x',
    title: 'Something to watch',
    available_from: null,
    done_at: null,
    sort_order: 0,
    ...over,
  };
}
