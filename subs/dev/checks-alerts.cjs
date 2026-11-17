// Dashboard alerts (step 4): Cancel now, Decide by and Amount unknown in the Alerts
// list (SPEC §8.1), their order, acting on them in place (acceptance 20), and an
// older backfill left uncancelled (acceptance 19).
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const per = (id, service_id, started_on, renews_on, o = {}) => ({ id, service_id, started_on, renews_on, cancelled_on: null, access_ends_on: null, ...o });
const chg = (id, service_id, period_id, charged_on, amount_cents) => ({ id, service_id, period_id, charged_on, amount_cents, billing_interval: 'monthly', source: 'manual' });
const SEED = {
  services: [
    svc({ id: 's1', name: 'Netflix', manage_url: 'https://www.netflix.com/cancelplan' }),
    svc({ id: 's2', name: 'Hulu' }),
    svc({ id: 's3', name: 'Spotify', role: 'keeper', category: 'music', price_cents: 1199 }),
    svc({ id: 's4', name: 'Nintendo Switch Online', role: 'keeper', category: 'gaming', billing_interval: 'annual', price_cents: 2100, cancel_lead_days: 2 }),
    svc({ id: 's5', name: 'Claude', role: 'keeper', category: 'ai' }),
    svc({ id: 's6', name: 'Uzzu' }),
    svc({ id: 's7', name: 'Disney+', archived_at: '2026-10-01T00:00:00+00:00' }),
    svc({ id: 's8', name: 'iCloud+', category: 'storage', manage_url: null, manage_path: 'iPhone Settings → iCloud' }),
    svc({ id: 's9', name: 'Google One', role: 'keeper', category: 'storage', billing_interval: 'annual', price_cents: 5000 }),
    svc({ id: 's10', name: 'Mubi' }),
  ],
  periods: [
    per('p1', 's1', '2026-11-10', '2026-12-10'),
    // acceptance 19: a Mar 1 backfill left open, behind a June rotation that was cancelled
    per('p2a', 's2', '2026-03-01', '2026-12-01'),
    per('p2b', 's2', '2026-06-01', '2026-07-01', { cancelled_on: '2026-06-01', access_ends_on: '2026-06-30' }),
    per('p3', 's3', '2025-11-25', '2026-11-25'), // decide by nov 24
    per('p4', 's4', '2025-11-17', '2026-11-17'), // decide by nov 15: passed
    per('p5', 's5', '2026-11-20', '2026-12-20'), // decide by dec 19: 33 days out, no alert
    per('p6', 's6', '2026-10-01', '2026-11-01', { cancelled_on: '2026-10-01', access_ends_on: '2026-10-31' }),
    per('p8', 's8', '2026-11-10', '2026-12-10'),
    // a keeper's older open period alerts even far outside the 14-day window
    per('p9a', 's9', '2025-03-01', '2027-03-01'),
    per('p9b', 's9', '2026-06-01', '2027-06-01', { cancelled_on: '2026-06-01', access_ends_on: '2026-06-30' }),
    per('p10', 's10', '2026-11-01', null), // no renewal date on file
  ],
  charges: [
    chg('c2a', 's2', 'p2a', '2026-03-01', 1500),
    { ...chg('c2b', 's2', 'p2a', '2026-11-01', 1500), source: 'auto' },
    chg('c6', 's6', 'p6', '2026-10-01', null),
    chg('c7', 's7', null, '2026-09-01', null),
  ],
};

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('__seed', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  const fake = (fn, arg) => page.evaluate(fn, arg);
  const open = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('open'), id);
  const closed = (id) => page.waitForFunction((i) => !document.getElementById(i).classList.contains('open'), id);
  const text = (sel) => page.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const alerts = () => page.$$eval('.alert', (els) => els.map((el) => ({
    name: el.querySelector('.alert-name').textContent,
    tag: el.querySelector('.badge').textContent,
    text: el.querySelector('.alert-text').textContent.replace(/\u00a0/g, ' '), // prices are non-breaking
    actions: [...el.querySelectorAll('.alert-actions > *')].map((a) => a.textContent.trim()),
  })));
  const alertFor = (name) => `.alert:has(.alert-name:text-is("${name}"))`;
  const groups = () => page.$$eval('.group', (gs) => Object.fromEntries(gs.map((g) => [g.querySelector('.group-title').firstChild.textContent, [...g.querySelectorAll('.row-name')].map((n) => n.textContent)])));
  const dashboard = async () => {
    await page.goto(BASE + '#/');
    await page.waitForSelector('.subs-header');
  };

  // 1. the list: what's in it, in what order, with what text (SPEC §8.1)
  await dashboard();
  const list = await alerts();
  const want = [
    { name: 'Hulu', tag: 'cancel now', text: 'next charge dec 1 · the mar 1 period was never cancelled', actions: ['review periods'] },
    { name: 'iCloud+', tag: 'cancel now', text: 'next charge dec 10', actions: ['mark cancelled'] },
    { name: 'Netflix', tag: 'cancel now', text: 'next charge dec 10', actions: ['manage ↗', 'mark cancelled'] },
    { name: 'Mubi', tag: 'cancel now', text: 'still renewing', actions: ['manage ↗', 'mark cancelled'] },
    { name: 'Nintendo Switch Online', tag: 'decide by nov 15', text: 'that date has passed · renews nov 17 at $21.00 / yr', actions: ['manage ↗', 'mark cancelled'] },
    { name: 'Spotify', tag: 'decide by nov 24', text: 'renews nov 25 at $11.99 / mo', actions: ['manage ↗', 'mark cancelled'] },
    { name: 'Google One', tag: 'decide by feb 28, 2027', text: 'renews mar 1, 2027 at $50.00 / yr · the mar 1, 2025 period was never cancelled', actions: ['review periods'] },
    { name: 'Uzzu', tag: 'amount unknown', text: '1 charge has no amount', actions: ['edit charges'] },
  ];
  check('alerts: order, tags, text and actions', JSON.stringify(list) === JSON.stringify(want), JSON.stringify(list, null, 1));
  check('alerts title counts them', (await text('#alerts-title')) === 'alerts8');
  check('alerts come right after the spend tiles, before the checklist and the groups', await page.evaluate(() => {
    const view = document.getElementById('view');
    const kids = [...view.children].filter((el) => el.matches('section'));
    return kids[0]?.classList.contains('spend') && kids[1]?.classList.contains('alerts') && kids[2]?.classList.contains('checklist');
  }));
  check('archived Disney+ and far-off Claude have no alert', !list.some((a) => a.name === 'Disney+' || a.name === 'Claude'));
  check('only the passed decide-by is marked overdue', (await page.$$eval('.alert.is-overdue .alert-name', (els) => els.map((e) => e.textContent))).join() === 'Nintendo Switch Online');
  check('manage link opens the real page in a new tab', (await page.getAttribute(`${alertFor('Netflix')} a.btn`, 'href')) === 'https://www.netflix.com/cancelplan' && (await page.getAttribute(`${alertFor('Netflix')} a.btn`, 'target')) === '_blank' && (await page.getAttribute(`${alertFor('Netflix')} a.btn`, 'rel')) === 'noopener noreferrer');
  check('accessible names start with the visible label', (await page.getAttribute(`${alertFor('Netflix')} button`, 'aria-label')) === 'mark cancelled: Netflix' && (await page.getAttribute(`${alertFor('Netflix')} a.btn`, 'aria-label')) === 'manage: Netflix, opens in a new tab');
  check('badges stay on rows, not in alerts', !list.some((a) => /verify|price/.test(a.tag)));
  check('alerts 375: no sideways scroll', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/alerts-375.png`, fullPage: true });

  // 2. acceptance 19: the open Mar 1 period makes Hulu active, and it can't be archived
  check('acceptance 19: Hulu is in the active group', (await groups()).active.includes('Hulu'), JSON.stringify(await groups()));
  await page.click(`${alertFor('Hulu')} a.btn`);
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Hulu');
  check('acceptance 19: review periods opens the detail, archive is off', (await text('.detail-status')) === 'active · renews dec 1' && !(await page.isEnabled('[data-action="archive"]')));
  check('acceptance 19: history shows the open mar 1 period with its delete', (await text('.period.is-open .period-head')) === 'mar 1 → renewing next charge dec 1 delete…');
  check('acceptance 19: mark cancelled offered for the open period', await page.isVisible('.btn-primary[data-action="cancel"]'));
  await page.click('.btn-primary[data-action="cancel"]');
  await page.fill('#cancel-date', '2026-03-01');
  await page.click('#cancel-save');
  check('cancelling before a recorded charge is refused (SPEC §7.3)', (await text('[data-for="cancelled_on"]')) === 'it was charged on nov 1, so it was still renewing then. if it really ended earlier, delete the period and record it again' && await open('cancel-modal'));
  check('nothing saved', (await fake(() => window.__fake.tables.periods.find((p) => p.id === 'p2a').cancelled_on)) === null);
  await page.keyboard.press('Escape');
  await page.goBack();
  await page.waitForSelector('.alerts');

  // 3. Amount unknown leads to the service's charges
  await page.click(`${alertFor('Uzzu')} a.btn`);
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Uzzu');
  check('edit charges goes to the detail with the unknown charge', (await text('.charge-amount.unknown')) === 'amount unknown');
  await page.goBack();
  await page.waitForSelector('.alerts');

  // 4. acceptance 20: mark cancelled in place clears the alert without leaving the dashboard
  await page.click(`${alertFor('Netflix')} button`);
  check('mark cancelled opens the cancel dialog, no prompt', (await open('cancel-modal')) && (await page.isHidden('#cancel-prompt')) && (await text('#cancel-title')) === 'mark Netflix cancelled');
  await page.click('#cancel-save');
  await closed('cancel-modal');
  check('acceptance 20: still on the dashboard', (await page.$('.subs-header')) !== null && (await page.$('.detail')) === null);
  check('acceptance 20: Netflix alert gone, count down to 7', !(await alerts()).some((a) => a.name === 'Netflix') && (await text('#alerts-title')) === 'alerts7');
  check('acceptance 20: toast and group show active until', (await text('#toast')) === 'cancelled Netflix · active until dec 9' && (await groups())['active until…'].includes('Netflix'));
  const p1 = await fake(() => window.__fake.tables.periods.find((p) => p.id === 'p1'));
  check('saved the cancellation', p1.cancelled_on === '2026-11-16' && p1.access_ends_on === '2026-12-09', JSON.stringify(p1));

  // 5. keeper Decide by: cancelling clears it too
  await page.click(`${alertFor('Spotify')} button`);
  await page.click('#cancel-save');
  await closed('cancel-modal');
  check('decide by clears once the keeper is cancelled', !(await alerts()).some((a) => a.name === 'Spotify'));

  // 6. a failed cancel keeps the alert and shows why in the dialog
  await page.click(`${alertFor('iCloud+')} button`);
  await fake(() => { window.__fake.blockWrites = true; });
  await page.click('#cancel-save');
  await page.waitForFunction(() => document.querySelector('#cancel-error').textContent);
  check('blocked write: error in the dialog, it stays open', (await open('cancel-modal')) && (await text('#cancel-error')).startsWith("couldn't mark it cancelled"));
  await fake(() => { window.__fake.blockWrites = false; });
  await page.keyboard.press('Escape');
  check('blocked write: the alert is still there', (await alerts()).some((a) => a.name === 'iCloud+'));

  // 7. nothing to flag: no Alerts section at all
  await fake(() => {
    const t = window.__fake.tables;
    for (const p of t.periods) if (p.cancelled_on == null) { p.cancelled_on = '2026-11-16'; p.access_ends_on = '2026-11-30'; }
    for (const c of t.charges) if (c.amount_cents == null) c.amount_cents = 1500;
    localStorage.setItem('__seed', JSON.stringify(t)); // the fake re-seeds from this on reload
  });
  await page.reload();
  await page.waitForSelector('.subs-header');
  check('no alerts: the section is hidden', (await page.$('.alerts')) === null);

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
