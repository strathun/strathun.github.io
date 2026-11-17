import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCents, formatCents, centsToInput, formatPrice, isWebUrl,
  formValues, serviceFromForm, findNameConflict, groupServices,
  serviceBadges, canArchive, setupProgress, NEW_SERVICE, SERVICE_FIELDS,
} from './services.js';
import { groupByService } from './status.js';
import { svc, period, openBehindCancelled, TODAY } from './fixtures.js';

// ── money ───────────────────────────────────────────────────────────────────

test('parseCents reads dollars as exact cents', () => {
  const cases = {
    '12.99': 1299, '12': 1200, '12.5': 1250, '12.': 1200, '.5': 50, '0.99': 99,
    '$12.99': 1299, '$ 7': 700, '  15.00 ': 1500, '0': 0,
    // Float traps: parseFloat(x) * 100 gives 1998.9999…, 434.9999…, 114.9999…
    '19.99': 1999, '4.35': 435, '1.15': 115,
  };
  for (const [input, cents] of Object.entries(cases)) {
    assert.deepEqual(parseCents(input), { value: cents }, input);
  }
});

test('parseCents accepts a comma decimal from comma-locale keyboards', () => {
  assert.deepEqual(parseCents('12,99'), { value: 1299 });
  assert.deepEqual(parseCents('12,5'), { value: 1250 });
  assert.deepEqual(parseCents('$4,35'), { value: 435 });
  assert.deepEqual(parseCents('12,'), { value: 1200 });
  for (const ambiguous of ['1,299', '1,299.00', '1,2,3', '12,99.5']) {
    assert.ok(parseCents(ambiguous).error, ambiguous);
  }
});

test('parseCents: blank means unknown', () => {
  assert.deepEqual(parseCents(''), { value: null });
  assert.deepEqual(parseCents('   '), { value: null });
  assert.deepEqual(parseCents(null), { value: null });
});

test('parseCents rejects negatives, extra decimals and junk', () => {
  for (const input of ['-1', '12.999', '1,299', 'abc', '.', '$', '12.3.4', '12 99', '99999999']) {
    assert.ok(parseCents(input).error, input);
  }
});

test('formatCents', () => {
  assert.equal(formatCents(1299), '$12.99');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-833), '-$8.33');
  assert.equal(formatCents(null), '—');
});

test('formatCents rounds fractional cents to the nearest cent, only for display (SPEC §7)', () => {
  assert.equal(formatCents(5000 / 12), '$4.17', 'an annual $50 run rate');
  assert.equal(formatCents(10000 / 12), '$8.33');
  assert.equal(formatCents(833.5), '$8.34');
  assert.equal(formatCents(12000.000000000002), '$120.00', 'float noise from summed run rates');
  assert.equal(formatCents(-0.4), '$0.00', 'no negative zero');
});

test('centsToInput round-trips through parseCents', () => {
  for (const cents of [0, 5, 99, 100, 1299, 2100, 123456]) {
    assert.equal(parseCents(centsToInput(cents)).value, cents);
  }
  assert.equal(centsToInput(null), '');
});

test('formatPrice shows price and interval, including unknown prices', () => {
  assert.equal(formatPrice(svc({ price_cents: 1599, billing_interval: 'monthly' })), '$15.99 / mo');
  assert.equal(formatPrice(svc({ price_cents: 5000, billing_interval: 'annual' })), '$50.00 / yr');
  assert.equal(formatPrice(svc({ price_cents: null, billing_interval: 'weekly' })), '— / wk');
});

test('isWebUrl allows only http(s)', () => {
  assert.ok(isWebUrl('https://www.netflix.com/cancelplan'));
  assert.ok(isWebUrl('http://example.com'));
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'netflix.com', '', null, 'ftp://x.com']) {
    assert.equal(isWebUrl(bad), false, String(bad));
  }
});

// ── form ↔ row ──────────────────────────────────────────────────────────────

const valid = (over = {}) => ({ ...formValues(), name: 'Netflix', ...over });

test('formValues of a new service has the form defaults', () => {
  assert.deepEqual(formValues(), {
    name: '', category: '', role: 'rotator', billing_interval: 'monthly',
    price: '', price_checked_on: '', manage_url: '', manage_path: '', help_url: '',
    url_verified: false, cancel_lead_days: '1', notes: '',
  });
});

test('a saved row round-trips through the form unchanged', () => {
  const row = {
    name: 'Nintendo Switch Online', category: 'gaming', role: 'keeper', billing_interval: 'annual',
    price_cents: 2100, price_checked_on: '2026-10-01', manage_url: 'https://accounts.nintendo.com/portal',
    manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 2, notes: 'line one\nline two',
  };
  const out = serviceFromForm(formValues(row), { today: TODAY, previous: row });
  assert.deepEqual(out, { row, errors: {} });
  assert.deepEqual(Object.keys(out.row), SERVICE_FIELDS);
});

test('trims text and stores blanks as null', () => {
  const { row } = serviceFromForm(
    valid({ name: '  Netflix  ', manage_url: ' ', manage_path: '  ', notes: '\n ', category: '' }),
    { today: TODAY },
  );
  assert.equal(row.name, 'Netflix');
  assert.equal(row.manage_url, null);
  assert.equal(row.manage_path, null);
  assert.equal(row.notes, null);
  assert.equal(row.category, null);
});

test('reports every invalid field at once, and no row', () => {
  const { row, errors } = serviceFromForm(
    {
      name: ' ', category: 'news', role: 'owner', billing_interval: 'daily', price: '-3',
      price_checked_on: '2026-02-30', manage_url: 'javascript:alert(1)', help_url: 'example.com',
      cancel_lead_days: '1.5', url_verified: false, manage_path: '', notes: '',
    },
    { today: TODAY },
  );
  assert.equal(row, null);
  assert.deepEqual(Object.keys(errors).sort(), [
    'billing_interval', 'cancel_lead_days', 'category', 'help_url', 'manage_url',
    'name', 'price', 'price_checked_on', 'role',
  ]);
});

test('name length limit', () => {
  assert.ok(serviceFromForm(valid({ name: 'x'.repeat(101) }), { today: TODAY }).errors.name);
  assert.equal(serviceFromForm(valid({ name: 'x'.repeat(100) }), { today: TODAY }).row.name.length, 100);
});

test('price checked date cannot be in the future', () => {
  const { errors } = serviceFromForm(valid({ price: '9.99', price_checked_on: '2026-11-17' }), { today: TODAY });
  assert.equal(errors.price_checked_on, "can't be in the future");
});

test('cancel lead days: blank defaults to 1, 0 allowed, bounded', () => {
  assert.equal(serviceFromForm(valid({ cancel_lead_days: '' }), { today: TODAY }).row.cancel_lead_days, 1);
  assert.equal(serviceFromForm(valid({ cancel_lead_days: '0' }), { today: TODAY }).row.cancel_lead_days, 0);
  assert.equal(serviceFromForm(valid({ cancel_lead_days: ' 2 ' }), { today: TODAY }).row.cancel_lead_days, 2);
  for (const bad of ['-1', '366', 'two', '1e2']) {
    assert.ok(serviceFromForm(valid({ cancel_lead_days: bad }), { today: TODAY }).errors.cancel_lead_days, bad);
  }
});

// D2: changing the price fills price_checked_on with today unless the date was set.
test('new service with a price and no date → checked today', () => {
  const { row } = serviceFromForm(valid({ price: '15.49' }), { today: TODAY });
  assert.equal(row.price_cents, 1549);
  assert.equal(row.price_checked_on, TODAY);
});

test('new service with a price and a date → keeps the date', () => {
  const { row } = serviceFromForm(valid({ price: '15.49', price_checked_on: '2026-09-01' }), { today: TODAY });
  assert.equal(row.price_checked_on, '2026-09-01');
});

test('new service with no price → no checked date', () => {
  assert.equal(serviceFromForm(valid(), { today: TODAY }).row.price_checked_on, null);
});

test('editing: price changed, date untouched → checked today', () => {
  const previous = svc({ price_cents: 1549, price_checked_on: '2026-01-10' });
  const { row } = serviceFromForm(formValues({ ...previous, price_cents: 1799 }), { today: TODAY, previous });
  assert.equal(row.price_cents, 1799);
  assert.equal(row.price_checked_on, TODAY);
});

test('editing: price first entered on a priceless service → checked today', () => {
  const previous = svc({ price_cents: null, price_checked_on: null });
  const { row } = serviceFromForm(valid({ ...formValues(previous), price: '10' }), { today: TODAY, previous });
  assert.equal(row.price_checked_on, TODAY);
});

test('editing: price changed and date changed → keeps the typed date', () => {
  const previous = svc({ price_cents: 1549, price_checked_on: '2026-01-10' });
  const values = { ...formValues(previous), price: '17.99', price_checked_on: '2026-11-01' };
  assert.equal(serviceFromForm(values, { today: TODAY, previous }).row.price_checked_on, '2026-11-01');
});

test('editing: price unchanged → date left alone', () => {
  const previous = svc({ price_cents: 1549, price_checked_on: '2026-01-10' });
  const values = { ...formValues(previous), name: 'Renamed' };
  assert.equal(serviceFromForm(values, { today: TODAY, previous }).row.price_checked_on, '2026-01-10');
});

test('editing: price cleared → date left alone (Price unknown takes over)', () => {
  const previous = svc({ price_cents: 1549, price_checked_on: '2026-01-10' });
  const { row } = serviceFromForm({ ...formValues(previous), price: '' }, { today: TODAY, previous });
  assert.equal(row.price_cents, null);
  assert.equal(row.price_checked_on, '2026-01-10');
});

test('NEW_SERVICE and SERVICE_FIELDS match the editable services columns', () => {
  assert.deepEqual(SERVICE_FIELDS, [
    'name', 'category', 'role', 'billing_interval', 'price_cents', 'price_checked_on',
    'manage_url', 'manage_path', 'help_url', 'url_verified', 'cancel_lead_days', 'notes',
  ]);
  assert.equal(NEW_SERVICE.cancel_lead_days, 1); // schema default
  assert.equal(NEW_SERVICE.url_verified, false); // schema default
});

// ── name conflicts ──────────────────────────────────────────────────────────

test('findNameConflict is case-insensitive, trims, and includes archived', () => {
  const live = svc({ id: 'a', name: 'Netflix' });
  const gone = svc({ id: 'b', name: 'Disney+', archived_at: '2026-06-01T00:00:00+00:00' });
  assert.equal(findNameConflict([live, gone], ' netflix '), live);
  assert.equal(findNameConflict([live, gone], 'DISNEY+'), gone);
  assert.equal(findNameConflict([live, gone], 'Hulu'), null);
  assert.equal(findNameConflict([live, gone], ''), null);
});

test('findNameConflict ignores the service being edited', () => {
  const live = svc({ id: 'a', name: 'Netflix' });
  assert.equal(findNameConflict([live], 'NETFLIX', 'a'), null);
});

// ── dashboard ───────────────────────────────────────────────────────────────

test('groupServices sorts each group by name and puts archived aside', () => {
  const s = {
    zed: svc({ id: 'z', name: 'zed' }),
    apple: svc({ id: 'a', name: 'Apple TV' }),
    netflix: svc({ id: 'n', name: 'Netflix' }),
    spotify: svc({ id: 's', name: 'Spotify', role: 'keeper' }),
    disney: svc({ id: 'd', name: 'Disney+', archived_at: '2026-06-01T00:00:00+00:00' }),
  };
  const periods = groupByService([
    period({ service_id: 's', started_on: '2026-11-01', renews_on: '2026-12-01' }),
    period({ service_id: 'n', started_on: '2026-11-10', renews_on: '2026-12-10', cancelled_on: '2026-11-10' }),
    // Archived but still renewing: stays in `archived`, never on the dashboard.
    period({ service_id: 'd', started_on: '2026-11-01', renews_on: '2026-12-01' }),
  ]);
  const g = groupServices(Object.values(s), periods, TODAY);
  const names = (list) => list.map((e) => e.service.name);
  assert.deepEqual(names(g.renewing), ['Spotify']);
  assert.deepEqual(names(g.ending), ['Netflix']);
  assert.equal(g.ending[0].accessEndsOn, '2026-12-09');
  assert.deepEqual(names(g.inactive), ['Apple TV', 'zed']);
  assert.deepEqual(names(g.archived), ['Disney+']);
  assert.equal(g.archived[0].status, 'renewing');
});

test('groupServices with no services or periods', () => {
  assert.deepEqual(groupServices([], new Map(), TODAY), { renewing: [], ending: [], inactive: [], archived: [] });
  const g = groupServices([svc({ id: 'x' })], new Map(), TODAY);
  assert.equal(g.inactive.length, 1);
  assert.equal(g.inactive[0].period, null);
});

test('serviceBadges: only service-level alerts, in alert order', () => {
  const s = svc({ url_verified: false, price_cents: null });
  assert.deepEqual(serviceBadges(s, TODAY).map((a) => a.type), ['verify_link', 'price_unknown']);
  const stale = svc({ price_cents: 999, price_checked_on: '2026-05-01' });
  assert.deepEqual(serviceBadges(stale, TODAY), [{ type: 'check_price', checkedOn: '2026-05-01' }]);
  assert.deepEqual(serviceBadges(svc(), TODAY), []);
});

test('serviceBadges: archived services show none', () => {
  assert.deepEqual(serviceBadges(svc({ url_verified: false, archived_at: '2026-06-01T00:00:00+00:00' }), TODAY), []);
});

test('canArchive: not while renewing (SPEC §8.4)', () => {
  assert.equal(canArchive('renewing'), false);
  assert.equal(canArchive('ending'), true);
  assert.equal(canArchive('inactive'), true);
});

test('setupProgress counts priced services, ignoring archived ones', () => {
  assert.deepEqual(setupProgress([]), { priced: 0, total: 0 });
  assert.deepEqual(
    setupProgress([
      svc({ price_cents: 1500 }),
      svc({ price_cents: 0 }), // free is still a known price
      svc({ price_cents: null }),
      svc({ price_cents: null, archived_at: '2026-06-01T00:00:00+00:00' }),
      svc({ price_cents: 999, archived_at: '2026-06-01T00:00:00+00:00' }),
    ]),
    { priced: 2, total: 3 },
  );
});

test("acceptance 19: an older uncancelled period groups the service as renewing, so it can't be archived", () => {
  const g = groupServices([svc({ id: 'n', name: 'Netflix' })], groupByService(openBehindCancelled('n')), TODAY);
  assert.deepEqual(g.renewing.map((e) => e.service.id), ['n']);
  assert.equal(canArchive(g.renewing[0].status), false);
});
