// Dashboard spend tiles (step 5): the three numbers for this year (SPEC §7.5, §8.1),
// archived services counted (acceptance 3), unknown amounts left out, rounding to the
// cent only on screen, and the tiles following a change without a reload.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const per = (id, service_id, started_on, renews_on, o = {}) => ({ id, service_id, started_on, renews_on, cancelled_on: null, access_ends_on: null, ...o });
const chg = (id, service_id, period_id, charged_on, amount_cents, o = {}) => ({ id, service_id, period_id, charged_on, amount_cents, billing_interval: 'monthly', source: 'manual', ...o });
const ended = (cancelled_on, access_ends_on) => ({ cancelled_on, access_ends_on });

// Frozen clock: 2026-11-16, so M = 11.
const SEED = {
  services: [
    svc({ id: 'go', name: 'Google One', role: 'keeper', category: 'storage', billing_interval: 'annual', price_cents: 5000 }),
    svc({ id: 'nf', name: 'Netflix', price_cents: 1799 }),
    svc({ id: 'sp', name: 'Spotify', role: 'keeper', category: 'music', price_cents: 1199 }),
    svc({ id: 'uz', name: 'Uzzu', price_cents: 1000 }),
    svc({ id: 'hu', name: 'Hulu', price_cents: 999, archived_at: '2026-03-15T00:00:00+00:00' }),
  ],
  periods: [
    per('p-go', 'go', '2025-12-05', '2026-12-05'),
    per('p-nf1', 'nf', '2026-03-01', '2026-04-01', ended('2026-03-01', '2026-03-31')),
    per('p-nf2', 'nf', '2026-06-01', '2026-07-01', ended('2026-06-01', '2026-06-30')),
    per('p-nf3', 'nf', '2026-11-10', '2026-12-10'),
    per('p-sp', 'sp', '2026-09-14', '2026-12-14'),
    per('p-uz', 'uz', '2026-11-01', '2026-12-01', ended('2026-11-01', '2026-11-30')),
    per('p-hu', 'hu', '2026-02-01', '2026-03-01', ended('2026-02-01', '2026-02-28')),
  ],
  charges: [
    // $50 annual on Dec 5, 2025: 416¢ for Dec–Mar, 417¢ for Apr–Nov (SPEC §7.4 remainder rule)
    chg('c-go', 'go', 'p-go', '2025-12-05', 5000, { billing_interval: 'annual' }),
    chg('c-nf1', 'nf', 'p-nf1', '2026-03-01', 1549),
    chg('c-nf2', 'nf', 'p-nf2', '2026-06-01', null), // unknown: left out of every number
    chg('c-nf3', 'nf', 'p-nf3', '2026-11-10', 1799),
    chg('c-sp1', 'sp', 'p-sp', '2026-09-14', 1199),
    chg('c-sp2', 'sp', 'p-sp', '2026-10-14', 1199, { source: 'auto' }),
    chg('c-sp3', 'sp', 'p-sp', '2026-11-14', 1199, { source: 'auto' }),
    chg('c-uz', 'uz', 'p-uz', '2026-11-01', 1000),
    chg('c-hu', 'hu', 'p-hu', '2026-02-01', 999), // archived: still counts
  ],
};

// Expected, by hand (cents):
//   monthly  jan 416 · feb 416+999 · mar 416+1549 · apr–aug 417 · sep, oct 417+1199 · nov 417+1199+1799+1000
//   this month = 4415            → $44.15
//   so far     = 13528           → $135.28
//   average    = 13528 / 11      → $12.30 (1229.8…)
//   cash       = 999+1549+1799+3×1199+1000 = 8944 → $89.44 (the Google One charge is 2025's)
//   projected  = 13528 + Dec run rate of renewing services (5000/12 + 1799 + 1199) → $169.43
const WANT = {
  thisMonth: '$44.15', average: '$12.30', soFar: '$135.28',
  subs: ['jan–nov', 'projected $169.43 if nothing changes', 'cash paid $89.44'],
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
  const tiles = () => page.$$eval('.spend .tile', (els) => els.map((el) => ({
    label: el.querySelector('dt').textContent.trim(),
    value: el.querySelector('.tile-value').textContent.trim(),
    subs: [...el.querySelectorAll('.tile-sub')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()),
  })));
  const numbers = async () => {
    const t = await tiles();
    return { thisMonth: t[0]?.value, average: t[1]?.value, soFar: t[2]?.value, subs: t.flatMap((x) => x.subs) };
  };
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const dashboard = async () => {
    await page.goto(BASE + '#/');
    await page.waitForSelector('.spend .tile');
  };

  // 1. the numbers, labels and where they sit
  await dashboard();
  const t = await tiles();
  check('three tiles labelled this month · average monthly · this year so far',
    JSON.stringify(t.map((x) => x.label)) === JSON.stringify(['this month', 'average monthly', 'this year so far']), JSON.stringify(t.map((x) => x.label)));
  const got = await numbers();
  check('tiles show the hand-worked numbers (archived Hulu counted, unknown amount left out, rounded to the cent)',
    JSON.stringify(got) === JSON.stringify(WANT), JSON.stringify(got));
  check('section is titled with the year', (await page.textContent('#spend-title')) === 'spend 2026');
  const order = await page.$$eval('#view > *', (els) => els.map((el) => el.className.split(' ')[0]));
  check('tiles sit between the header and the alerts (SPEC §8.1 order)',
    order.indexOf('spend') === order.indexOf('subs-header') + 1 && order.indexOf('spend') < order.indexOf('alerts'), order.join(','));

  // 2. phone width: last tile spans the row, nothing scrolls sideways
  const boxes = await page.$$eval('.spend .tile', (els) => els.map((el) => el.getBoundingClientRect().width));
  check('at 375px: two tiles share a row and the third spans it', boxes.length === 3 && Math.abs(boxes[0] - boxes[1]) < 1 && boxes[2] > boxes[0] * 1.9, boxes.map(Math.round).join(','));
  check('at 375px the page never scrolls sideways', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/spend-375.png`, fullPage: true });

  // 3. desktop: three in a row
  await page.setViewportSize({ width: 1024, height: 800 });
  const tops = await page.$$eval('.spend .tile', (els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  check('at 1024px the three tiles share one row', new Set(tops).size === 1, tops.join(','));
  await page.screenshot({ path: `${h.SHOTS}/spend-1024.png` });
  await page.setViewportSize({ width: 375, height: 800 });

  // 4. acceptance 3: archiving a service changes no spend number
  await page.goto(BASE + '#/s/uz');
  await page.click('[data-action="archive"]');
  await page.waitForFunction(() => document.querySelector('.detail-status')?.textContent.includes('archived'));
  await dashboard();
  check('acceptance 3: Uzzu is off the dashboard list', !(await page.$$eval('.service-list .row-name', (ns) => ns.some((n) => n.textContent === 'Uzzu'))));
  check('acceptance 3: archiving Uzzu leaves every tile unchanged', JSON.stringify(await numbers()) === JSON.stringify(WANT), JSON.stringify(await numbers()));

  // 5. the tiles follow a change without a reload: cancelling Netflix drops its Dec run rate
  await page.click('.alert:has(.alert-name:text-is("Netflix")) [data-action="cancel"]');
  await page.click('#cancel-save');
  await page.waitForFunction(() => !document.getElementById('cancel-modal').classList.contains('open'));
  const after = await numbers();
  check('cancelling Netflix: projection drops by its $17.99 run rate, nothing else moves',
    after.subs[1] === 'projected $151.44 if nothing changes' && after.soFar === WANT.soFar && after.thisMonth === WANT.thisMonth, JSON.stringify(after));

  // 6. no services: no tiles, just the starter offer
  const empty = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  const p2 = await empty.newPage();
  await p2.goto(BASE + '#/');
  await p2.waitForSelector('[data-action="load-starter"]');
  check('with no services there are no tiles', !(await p2.$('.spend')));
  await empty.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  report();
})();
