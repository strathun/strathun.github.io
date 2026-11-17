// Year view (step 5): the §7.6 grid and the spend tiles for a selected year (SPEC §8.2),
// the totals row against This month (acceptance 12), past and future years (acceptance 21),
// the #/y/{year} URL and its range (acceptance 22), archiving (acceptance 3), and the
// phone layout where only the grid scrolls sideways (acceptance 16).
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const per = (id, service_id, started_on, renews_on, o = {}) => ({ id, service_id, started_on, renews_on, cancelled_on: null, access_ends_on: null, ...o });
const chg = (id, service_id, period_id, charged_on, amount_cents, o = {}) => ({ id, service_id, period_id, charged_on, amount_cents, billing_interval: 'monthly', source: 'manual', ...o });
const ended = (cancelled_on, access_ends_on) => ({ cancelled_on, access_ends_on });

// Frozen clock: 2026-11-16, so M = 11. Names are seeded out of order on purpose.
const SEED = {
  services: [
    svc({ id: 'uz', name: 'Uzzu', price_cents: 1000 }),
    svc({ id: 'nf', name: 'Netflix', price_cents: 1799 }),
    svc({ id: 'go', name: 'Google One', role: 'keeper', category: 'storage', billing_interval: 'annual', price_cents: 5000 }),
    svc({ id: 'sp', name: 'Spotify', role: 'keeper', category: 'music', price_cents: 1199 }),
    svc({ id: 'ns', name: 'Nintendo Switch Online', role: 'keeper', category: 'gaming', billing_interval: 'annual', price_cents: 2100 }),
    svc({ id: 'hu', name: 'Hulu', price_cents: 999, archived_at: '2026-03-15T00:00:00+00:00' }),
  ],
  periods: [
    per('p-go', 'go', '2025-12-05', '2026-12-05'),
    per('p-nf1', 'nf', '2026-03-01', '2026-04-01', ended('2026-03-01', '2026-03-31')),
    per('p-nf2', 'nf', '2026-06-01', '2026-07-01', ended('2026-06-01', '2026-06-30')),
    per('p-nf3', 'nf', '2026-11-10', '2026-12-10'),
    per('p-sp', 'sp', '2026-09-14', '2026-12-14'),
    per('p-ns', 'ns', '2026-03-20', '2027-03-20'),
    per('p-uz', 'uz', '2026-11-01', '2026-12-01', ended('2026-11-01', '2026-11-30')),
    per('p-hu', 'hu', '2026-02-01', '2026-03-01', ended('2026-02-01', '2026-02-28')),
  ],
  charges: [
    chg('c-go', 'go', 'p-go', '2025-12-05', 5000, { billing_interval: 'annual' }), // 4.16 Dec–Mar, 4.17 Apr–Nov
    chg('c-nf1', 'nf', 'p-nf1', '2026-03-01', 1549),
    chg('c-nf2', 'nf', 'p-nf2', '2026-06-01', null), // unknown: June is active with no amount
    chg('c-nf3', 'nf', 'p-nf3', '2026-11-10', 1799),
    chg('c-sp1', 'sp', 'p-sp', '2026-09-14', 1199),
    chg('c-sp2', 'sp', 'p-sp', '2026-10-14', 1199, { source: 'auto' }),
    chg('c-sp3', 'sp', 'p-sp', '2026-11-14', 1199, { source: 'auto' }),
    chg('c-ns', 'ns', 'p-ns', '2026-03-20', 2100, { billing_interval: 'annual' }), // 1.75 Mar 2026–Feb 2027
    chg('c-uz', 'uz', 'p-uz', '2026-11-01', 1000),
    chg('c-hu', 'hu', 'p-hu', '2026-02-01', 999),
  ],
};

// Expected, by hand. 2026 totals per month (cents):
//   jan 416 · feb 416+999 · mar 416+1549+175 · apr–aug 417+175 · sep, oct 417+1199+175
//   nov 417+1199+1799+1000+175 · dec 175 (Nintendo, paid ahead: muted)
const TOTALS_2026 = ['4.16', '14.15', '21.40', '5.92', '5.92', '5.92', '5.92', '5.92', '17.91', '17.91', '45.90', '1.75'];
// Tiles 2026: this month 4590 · so far 15103 · average 15103/11 = 1373 · cash 11044
//   projected = 15103 + 175 committed (dec) + dec run rate of Google One, Netflix, Spotify (416.67+1799+1199) → 18692.67
const TILES_2026 = { values: ['$45.90', '$13.73', '$151.03'], subs: ['jan–nov', 'projected $186.93 if nothing changes', 'cash paid $110.44'] };
// 2025 (past, M = 12): only Google One's Dec slice. Average 416/12 = 34.67¢.
const TILES_2025 = { labels: ['december', 'average monthly', 'year total'], values: ['$4.16', '$0.35', '$4.16'], subs: ['jan–dec', 'cash paid $50.00'] };
// 2027 (future, M = 0): Nintendo's Jan, Feb slices (350) + run rate for every month with nothing
//   committed: Google One 5000 + Netflix 12×1799 + Spotify 12×1199 + Nintendo 10×175 = 42726 → 43076
const TILES_2027 = { values: ['—', '—', '—'], subs: ['projected $430.76 if nothing changes', 'cash paid $0.00'] };

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('__seed', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const tiles = () => page.$$eval('.spend .tile', (els) => ({
    labels: els.map((el) => el.querySelector('dt').textContent.trim()),
    values: els.map((el) => el.querySelector('.tile-value').textContent.trim()),
    subs: els.flatMap((el) => [...el.querySelectorAll('.tile-sub')].map((s) => s.textContent.replace(/\s+/g, ' ').trim())),
  }));
  // Visible text only: drop the screen-reader " active" before reading amounts.
  const grid = () => page.evaluate(() => {
    const visible = (el) => { const c = el.cloneNode(true); c.querySelectorAll('.sr-only').forEach((s) => s.remove()); return c.textContent.trim(); };
    const rows = [...document.querySelectorAll('.year-grid tbody tr')].map((tr) => ({
      name: tr.querySelector('.grid-name').textContent,
      archived: !!tr.querySelector('.grid-sub'),
      cells: [...tr.querySelectorAll('td')].map((td) => ({
        text: visible(td), active: td.classList.contains('is-active'), future: td.classList.contains('is-future'),
        sr: td.querySelector('.sr-only')?.textContent.trim() ?? '',
      })),
    }));
    const totals = [...document.querySelectorAll('.year-grid tfoot td')].map(visible);
    const now = [...document.querySelectorAll('.year-grid thead th')].findIndex((th) => th.classList.contains('is-now'));
    return { rows, totals, now };
  });
  const row = (g, name) => g.rows.find((r) => r.name === name);
  const months = (r, pred) => r.cells.map((c, i) => (pred(c) ? i + 1 : null)).filter(Boolean);
  const year = async (hash) => {
    await page.goto(BASE + hash);
    await page.waitForSelector('.year-title');
  };
  const shown = () => page.textContent('.year-title');

  // 1. this year: rows, cells, totals (SPEC §7.6, §8.2)
  await year('#/y/2026');
  let g = await grid();
  check('rows sorted by name, archived Hulu included and marked',
    g.rows.map((r) => r.name).join() === 'Google One,Hulu,Netflix,Nintendo Switch Online,Spotify,Uzzu' && row(g, 'Hulu').archived && !row(g, 'Netflix').archived,
    g.rows.map((r) => r.name + (r.archived ? '*' : '')).join());
  const nf = row(g, 'Netflix');
  check('Netflix: active in mar, jun (unknown amount: blank) and nov', months(nf, (c) => c.active).join() === '3,6,11', months(nf, (c) => c.active).join());
  check('Netflix amounts: mar 15.49, jun blank, nov 17.99', nf.cells[2].text === '15.49' && nf.cells[5].text === '' && nf.cells[10].text === '17.99');
  check('active cells say so to screen readers, inactive ones do not', nf.cells[5].sr === 'active' && nf.cells[0].sr === '');
  const go = row(g, 'Google One');
  check('Google One: active jan–nov while renewing, dec is future and not active',
    months(go, (c) => c.active).join() === '1,2,3,4,5,6,7,8,9,10,11' && go.cells[11].future && !go.cells[11].active);
  check('Google One: the 2025 annual charge spread as 4.16 (jan–mar) and 4.17 (apr–nov)',
    go.cells.slice(0, 3).every((c) => c.text === '4.16') && go.cells.slice(3, 11).every((c) => c.text === '4.17') && go.cells[11].text === '');
  const ns = row(g, 'Nintendo Switch Online');
  check('Nintendo: dec shows the paid-ahead 1.75, muted and not active', ns.cells[11].text === '1.75' && ns.cells[11].future && !ns.cells[11].active);
  check('totals row, every month', JSON.stringify(g.totals) === JSON.stringify(TOTALS_2026), JSON.stringify(g.totals));
  check('november is marked as this month', g.now === 11, String(g.now));

  // 2. acceptance 12: totals row for this month equals the This month tile, on both pages
  const t2026 = await tiles();
  check('year view tiles for 2026 match the hand-worked numbers',
    JSON.stringify({ values: t2026.values, subs: t2026.subs }) === JSON.stringify(TILES_2026), JSON.stringify(t2026));
  check('the year view has no "year view" link of its own', !(await page.$('.spend .section-head a')));
  check('acceptance 12: nov total equals the This month tile', `$${g.totals[10]}` === t2026.values[0]);
  await page.goto(BASE + '#/');
  await page.waitForSelector('.spend .tile');
  const dash = await tiles();
  check('acceptance 12: the dashboard tiles are the same numbers', JSON.stringify(dash.values) === JSON.stringify(t2026.values) && dash.values[0] === `$${g.totals[10]}`);

  // 3. phone width: only the grid scrolls sideways, the name column stays put (acceptance 16)
  await year('#/y/2026');
  check('at 375px the page never scrolls sideways', await noSideScroll());
  const wrap = await page.$eval('.grid-wrap', (el) => ({ scrolls: el.scrollWidth > el.clientWidth, focusable: el.tabIndex === 0 }));
  check('at 375px the grid scrolls inside its own container, reachable by keyboard', wrap.scrolls && wrap.focusable);
  await page.screenshot({ path: `${h.SHOTS}/year-375.png`, fullPage: true });
  const stuck = await page.evaluate(() => {
    const el = document.querySelector('.grid-wrap');
    el.scrollLeft = el.scrollWidth;
    const name = document.querySelector('.year-grid tbody .name').getBoundingClientRect().left;
    return { scrolled: el.scrollLeft > 0, offset: Math.round(name - el.getBoundingClientRect().left) };
  });
  check('scrolled to the end, the service-name column is still at the left edge', stuck.scrolled && stuck.offset <= 1, JSON.stringify(stuck));
  await page.screenshot({ path: `${h.SHOTS}/year-375-scrolled.png` });
  await page.setViewportSize({ width: 1024, height: 800 });
  check('at 1024px the whole year fits without scrolling', await page.$eval('.grid-wrap', (el) => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${h.SHOTS}/year-1024.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 800 });

  // 4. a past year (acceptance 21): december, the year total, no projection
  await year('#/y/2025');
  g = await grid();
  const t2025 = await tiles();
  check('2025 tiles: december, average, year total with cash and no projection',
    JSON.stringify(t2025) === JSON.stringify(TILES_2025), JSON.stringify(t2025));
  const sum = g.totals.reduce((s, x) => s + Math.round(Number(x) * 100), 0);
  check('acceptance 21: the year total equals the sum of the totals row', t2025.values[2] === `$${(sum / 100).toFixed(2)}`, `${sum}`);
  check('2025: only Google One, active in dec, nothing muted, no month marked',
    g.rows.map((r) => r.name).join() === 'Google One' && months(g.rows[0], (c) => c.active).join() === '12' && g.rows[0].cells.every((c) => !c.future) && g.now === -1);

  // 5. a future year: committed slices only, muted; blank tiles except the projection
  await year('#/y/2027');
  g = await grid();
  const t2027 = await tiles();
  check('2027 tiles: blank so far, average and this month; projection and cash',
    JSON.stringify({ values: t2027.values, subs: t2027.subs }) === JSON.stringify(TILES_2027), JSON.stringify(t2027));
  const ns27 = g.rows[0];
  check('2027: only Nintendo, jan and feb paid ahead (1.75, muted), nothing active',
    g.rows.length === 1 && ns27.name === 'Nintendo Switch Online' && ns27.cells[0].text === '1.75' && ns27.cells[1].text === '1.75'
      && ns27.cells[2].text === '' && ns27.cells.every((c) => c.future && !c.active));

  // 6. the switcher and the URL (acceptance 22)
  const links = async () => page.$$eval('.year-switch > *', (els) => els.map((el) => `${el.tagName === 'A' ? el.getAttribute('href') : 'off'}:${el.textContent}`));
  check('2027 is the last year: next is off', (await links()).join() === '#/y/2026:← 2026,off:2028 →', (await links()).join());
  await year('#/y/2025');
  check('2025 is the first year (the oldest charge): previous is off', (await links()).join() === 'off:← 2024,#/y/2026:2026 →', (await links()).join());
  await year('#/y');
  check('#/y shows this year and says so in the URL', (await shown()) === '2026' && (await page.evaluate(() => location.hash)) === '#/y/2026');
  await year('#/y/1999');
  check('acceptance 22: #/y/1999 shows the nearest year, 2025, and the URL follows', (await shown()) === '2025' && (await page.evaluate(() => location.hash)) === '#/y/2025');
  await year('#/y/3000');
  check('acceptance 22: #/y/3000 shows 2027', (await shown()) === '2027');

  // 7. back button: dashboard → year view → previous year → back, back
  await page.goto(BASE + '#/');
  await page.waitForSelector('.spend .tile');
  await page.click('.spend .section-head a');
  await page.waitForFunction(() => document.querySelector('.year-title')?.textContent === '2026');
  await page.click('.year-switch a:has-text("← 2025")');
  await page.waitForFunction(() => document.querySelector('.year-title')?.textContent === '2025');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.year-title')?.textContent === '2026');
  await page.goBack();
  await page.waitForSelector('.service-list');
  check('back steps 2025 → 2026 → dashboard', (await page.evaluate(() => location.hash)) === '#/');

  // 8. a row name opens the service
  await year('#/y/2026');
  await page.click('.grid-name:text-is("Spotify")');
  await page.waitForSelector('.detail-name');
  check('a row name opens its service detail', (await page.textContent('.detail-name')) === 'Spotify');

  // 9. acceptance 3: archiving changes nothing in the year view
  await year('#/y/2026');
  const before = { grid: await grid(), tiles: await tiles() };
  await page.goto(BASE + '#/s/uz');
  await page.click('[data-action="archive"]');
  await page.waitForFunction(() => document.querySelector('.detail-status')?.textContent.includes('archived'));
  await year('#/y/2026');
  const after = { grid: await grid(), tiles: await tiles() };
  const strip = (x) => JSON.stringify({ ...x, grid: { ...x.grid, rows: x.grid.rows.map(({ archived, ...r }) => r) } });
  check('acceptance 3: archiving Uzzu leaves the grid and tiles unchanged, and marks its row',
    strip(before) === strip(after) && row(after.grid, 'Uzzu').archived);

  // 10. no data at all: an empty year, this year and next on offer
  const blank = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  await blank.addInitScript(() => localStorage.setItem('__seed', JSON.stringify({ services: [{ id: 'x', name: 'Mubi', category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: null, price_checked_on: null, manage_url: null, manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null }], periods: [], charges: [] })));
  const p2 = await blank.newPage();
  await p2.goto(BASE + '#/y/2026');
  await p2.waitForSelector('.year-title');
  check('a year with nothing in it says so', (await p2.textContent('#view .empty')).trim() === 'nothing was active or charged in 2026.');
  check('with no periods or charges, previous is off', (await p2.$$eval('.year-switch > *', (els) => els.map((el) => el.tagName))).join() === 'SPAN,A');
  await blank.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  report();
})();
