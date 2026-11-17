// Period history and charges on service detail (step 4): order, text, auto badges,
// unknown amounts, charges in no period, empty state, 375px layout.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const chg = (o) => ({ period_id: null, amount_cents: 1500, billing_interval: 'monthly', source: 'manual', ...o });

// Open periods renew after the frozen today (2026-11-16), so catch-up never adds to them.
const SEED = {
  services: [
    svc({ id: 's1', name: 'Spotify', role: 'keeper', price_cents: 1199 }),
    svc({ id: 's2', name: 'Nintendo', role: 'keeper', billing_interval: 'annual', price_cents: 2100 }),
    svc({ id: 's3', name: 'Netflix' }),
  ],
  periods: [
    { id: 'p1', service_id: 's1', started_on: '2026-08-20', renews_on: '2026-11-20', cancelled_on: null, access_ends_on: null },
    { id: 'p0', service_id: 's1', started_on: '2026-02-03', renews_on: '2026-03-03', cancelled_on: '2026-02-03', access_ends_on: '2026-03-02' },
    { id: 'p2', service_id: 's2', started_on: '2025-08-10', renews_on: '2026-08-10', cancelled_on: '2025-08-10', access_ends_on: null },
  ],
  charges: [
    chg({ id: 'c1', service_id: 's1', period_id: 'p1', charged_on: '2026-08-20', amount_cents: 1199 }),
    chg({ id: 'c2', service_id: 's1', period_id: 'p1', charged_on: '2026-09-20', amount_cents: 1199, source: 'auto' }),
    chg({ id: 'c3', service_id: 's1', period_id: 'p1', charged_on: '2026-10-20', amount_cents: null, source: 'auto' }),
    chg({ id: 'c0', service_id: 's1', period_id: 'p0', charged_on: '2026-02-03', amount_cents: 1099 }),
    chg({ id: 'c9', service_id: 's1', period_id: null, charged_on: '2026-01-15', amount_cents: 999 }),
    chg({ id: 'c4', service_id: 's2', period_id: 'p2', charged_on: '2025-08-10', amount_cents: 2100, billing_interval: 'annual' }),
  ],
};

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  await ctx.addInitScript((s) => localStorage.setItem('__seed', JSON.stringify(s)), SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const history = () => page.$$eval('.history .period', (ps) => ps.map((p) => ({
    head: p.querySelector('.period-head').textContent.replace(/\s+/g, ' ').trim(),
    charges: [...p.querySelectorAll('.charge')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
  })));

  await page.goto(BASE + '#/s/s1');
  await page.waitForSelector('.history');
  const spotify = await history();
  check('periods newest first, open one says renewing + next charge',
    spotify[0].head === 'aug 20 → renewing next charge nov 20' && spotify[1].head === 'feb 3 → mar 2 cancelled feb 3', JSON.stringify(spotify.map((p) => p.head)));
  check('charges newest first with interval, auto badge and unknown amount',
    JSON.stringify(spotify[0].charges) === JSON.stringify(['oct 20 amount unknown / mo auto', 'sep 20 $11.99 / mo auto', 'aug 20 $11.99 / mo']), JSON.stringify(spotify[0].charges));
  check('charges in no period listed last', spotify[2].head === 'charges in no period' && spotify[2].charges[0] === 'jan 15 $9.99 / mo');
  check('unknown amount styled as a warning', (await page.$eval('.charge-amount.unknown', (e) => getComputedStyle(e).color)) !== (await page.$eval('.charge-date', (e) => getComputedStyle(e).color)));
  check('history 375: no sideways scroll', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/history-375.png`, fullPage: true });

  // annual charge in a past year shows the year; blank access end falls back to renews_on − 1
  await page.goto(BASE + '#/s/s2');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Nintendo');
  const nso = await history();
  check('past-year dates show the year, blank access end = renews_on − 1',
    nso[0].head === 'aug 10, 2025 → aug 9 cancelled aug 10, 2025' && nso[0].charges[0] === 'aug 10, 2025 $21.00 / yr', JSON.stringify(nso));

  // no periods
  await page.goto(BASE + '#/s/s3');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Netflix');
  check('no periods: empty message', (await page.textContent('.history')).includes('no periods yet'));

  check('loads charges once with the rest', await page.evaluate(() => window.__fake.calls.filter((c) => c.table === 'charges' && c.op === 'select').length === 1));
  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
