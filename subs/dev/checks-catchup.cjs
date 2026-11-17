// Automatic renewal catch-up on load (step 4, SPEC §7.3): which periods are charged,
// at what amount, idempotency across reloads and half-finished runs (acceptance 6, 9),
// and the error banner when it fails.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const per = (o) => ({ cancelled_on: null, access_ends_on: null, ...o });
const chg = (o) => ({ amount_cents: 1500, billing_interval: 'monthly', source: 'manual', ...o });

// Frozen today is 2026-11-16.
const SEED = {
  services: [
    svc({ id: 'spot', name: 'Spotify', role: 'keeper', price_cents: 1199 }),
    svc({ id: 'net', name: 'Netflix', price_cents: 1799 }),                 // forgotten rotator: still bills
    svc({ id: 'par', name: 'Paramount+', archived_at: '2026-10-20T00:00:00+00:00' }),
    svc({ id: 'unk', name: 'Mystery', price_cents: null }),
    svc({ id: 'eom', name: 'Month End', price_cents: 500 }),
    svc({ id: 'hulu', name: 'Hulu' }),                                     // cancelled: never charged
    svc({ id: 'fut', name: 'Future', role: 'keeper' }),                     // renews later: nothing yet
  ],
  periods: [
    per({ id: 'p-spot', service_id: 'spot', started_on: '2026-08-16', renews_on: '2026-09-16' }),
    per({ id: 'p-net', service_id: 'net', started_on: '2026-10-10', renews_on: '2026-11-10' }),
    per({ id: 'p-par', service_id: 'par', started_on: '2026-10-01', renews_on: '2026-11-01' }),
    per({ id: 'p-unk', service_id: 'unk', started_on: '2026-10-16', renews_on: '2026-11-16' }),
    per({ id: 'p-eom', service_id: 'eom', started_on: '2026-08-31', renews_on: '2026-09-30' }),
    per({ id: 'p-hulu', service_id: 'hulu', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' }),
    per({ id: 'p-fut', service_id: 'fut', started_on: '2026-11-01', renews_on: '2026-12-01' }),
  ],
  charges: [
    chg({ id: 'c-spot', service_id: 'spot', period_id: 'p-spot', charged_on: '2026-08-16', amount_cents: 1199 }),
  ],
};

async function open(browser, seed, { failNext = null } = {}) {
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } });
  // Seed once per context, so a reload keeps what reloadKeepingData() stored.
  await ctx.addInitScript(([s, f]) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem('__seed', JSON.stringify(s));
    if (f) localStorage.setItem('__failNext', JSON.stringify(f));
  }, [seed, failNext]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.subs-header');
  return { ctx, page, errors };
}

// The fake keeps tables in memory, so carry them across a reload by re-seeding.
async function reloadKeepingData(page) {
  await page.evaluate(() => localStorage.setItem('__seed', JSON.stringify(window.__fake.tables)));
  await page.reload();
  await page.waitForSelector('.subs-header, .detail');
}

const tables = (page) => page.evaluate(() => window.__fake.tables);
const chargesOf = (t, id) => t.charges.filter((c) => c.service_id === id).map((c) => [c.charged_on, c.amount_cents, c.source]).sort();
const renews = (t, id) => t.periods.find((p) => p.id === id).renews_on;

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();

  // 1. first load records what came due
  {
    const { ctx, page, errors } = await open(browser, SEED);
    const t = await tables(page);
    check('keeper: every missed month at the current price (acceptance 6)', JSON.stringify(chargesOf(t, 'spot')) === JSON.stringify([
      ['2026-08-16', 1199, 'manual'], ['2026-09-16', 1199, 'auto'], ['2026-10-16', 1199, 'auto'], ['2026-11-16', 1199, 'auto'],
    ]), JSON.stringify(chargesOf(t, 'spot')));
    check('keeper: renews_on advanced past today', renews(t, 'p-spot') === '2026-12-16');
    check('forgotten rotator is charged too', JSON.stringify(chargesOf(t, 'net')) === JSON.stringify([['2026-11-10', 1799, 'auto']]) && renews(t, 'p-net') === '2026-12-10');
    check('archived service with an open period is charged', chargesOf(t, 'par').length === 1 && renews(t, 'p-par') === '2026-12-01');
    check('unknown price → unknown amount', JSON.stringify(chargesOf(t, 'unk')) === JSON.stringify([['2026-11-16', null, 'auto']]));
    check('month-end start stays on month end', JSON.stringify(chargesOf(t, 'eom').map((c) => c[0])) === JSON.stringify(['2026-09-30', '2026-10-31']) && renews(t, 'p-eom') === '2026-11-30');
    check('cancelled and not-yet-due periods untouched', chargesOf(t, 'hulu').length === 0 && chargesOf(t, 'fut').length === 0 && renews(t, 'p-hulu') === '2026-04-01' && renews(t, 'p-fut') === '2026-12-01');
    const calls = await page.evaluate(() => window.__fake.calls);
    const ups = calls.filter((c) => c.op === 'upsert');
    check('one upsert for all charges, before any renews_on update', ups.length === 1 && calls.indexOf(ups[0]) < calls.findIndex((c) => c.table === 'periods' && c.op === 'update'));
    const upd = calls.filter((c) => c.table === 'periods' && c.op === 'update');
    check('each advance is guarded by the old renews_on', upd.length === 5 && upd.every((c) => c.filters.length === 2 && c.filters[1][0] === 'renews_on'), JSON.stringify(upd.map((c) => c.filters)));
    check('page reloaded after recording (two loads of charges)', calls.filter((c) => c.table === 'charges' && c.op === 'select').length === 2);
    check('toast counts the charges and names the services', (await page.textContent('#toast')) === 'recorded 8 renewals: Spotify, Netflix, Paramount+, Mystery, Month End', await page.textContent('#toast'));
    check('no error banner', (await page.$$('.banner-error')).length === 0);

    // detail shows the recorded charges
    await page.click('.service-row:has-text("Spotify")');
    await page.waitForSelector('.history');
    const rows = await page.$$eval('.history .charge', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    check('detail lists the auto charges, newest first', JSON.stringify(rows) === JSON.stringify(['nov 16 $11.99 / mo auto edit', 'oct 16 $11.99 / mo auto edit', 'sep 16 $11.99 / mo auto edit', 'aug 16 $11.99 / mo edit']), JSON.stringify(rows));
    check('detail: renews dec 16', (await page.textContent('.detail-status')).trim() === 'active · renews dec 16');

    // 2. reload: nothing more to do (acceptance 9)
    const before = (await tables(page)).charges.length;
    await reloadKeepingData(page);
    const calls2 = await page.evaluate(() => window.__fake.calls);
    check('reload: no writes at all', calls2.every((c) => c.op === 'select'), JSON.stringify(calls2.map((c) => c.op)));
    check('reload: same number of charges', (await tables(page)).charges.length === before);
    check('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // 3. a run that stopped after inserting charges: the next load finishes without duplicates
  {
    const half = JSON.parse(JSON.stringify(SEED));
    half.charges.push(chg({ id: 'c-sep', service_id: 'spot', period_id: 'p-spot', charged_on: '2026-09-16', amount_cents: 1199, source: 'auto' }));
    const { ctx, page, errors } = await open(browser, half);
    const t = await tables(page);
    check('half-finished run: no duplicate charges', JSON.stringify(chargesOf(t, 'spot').map((c) => c[0])) === JSON.stringify(['2026-08-16', '2026-09-16', '2026-10-16', '2026-11-16']), JSON.stringify(chargesOf(t, 'spot')));
    check('half-finished run: renews_on advanced', renews(t, 'p-spot') === '2026-12-16');
    check('half-finished run: toast counts only new charges', (await page.textContent('#toast')) === 'recorded 7 renewals: Spotify, Netflix, Paramount+, Mystery, Month End', await page.textContent('#toast'));
    check('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // 4. the charge insert fails: banner with the reason, nothing advanced, try again works
  {
    const { ctx, page, errors } = await open(browser, SEED, { failNext: { table: 'charges', op: 'upsert', code: '08006', message: 'connection failure' } });
    check('failure: banner explains and offers a retry', (await page.textContent('.banner-error span')) === "couldn't record renewals: connection failure" && await page.isVisible('.banner-error [data-action="reload"]'));
    const t = await tables(page);
    check('failure: no charges, no renews_on moved', t.charges.length === 1 && renews(t, 'p-spot') === '2026-09-16');
    check('failure: services still listed', (await page.$$('.service-row')).length === 6);
    await page.screenshot({ path: `${h.SHOTS}/catchup-error-375.png` });
    await page.click('.service-row:has-text("Netflix")');
    await page.waitForSelector('.detail');
    check('failure: banner on detail too', await page.isVisible('.banner-error'));
    await page.click('.banner-error [data-action="reload"]');
    await page.waitForFunction(() => !document.querySelector('.banner-error'));
    const t2 = await tables(page);
    check('try again records the renewals', chargesOf(t2, 'spot').length === 4 && renews(t2, 'p-spot') === '2026-12-16');
    check('try again keeps you on the same view', (await page.textContent('.detail-name')) === 'Netflix');
    check('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
