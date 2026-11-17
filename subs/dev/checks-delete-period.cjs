// Delete period (step 4, SPEC §8.3): the confirmation lists the charges it removes,
// it removes that period and its charges and nothing else (acceptance 18), failures
// keep the dialog open, and a re-subscribe works afterwards.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'keeper', billing_interval: 'monthly', price_cents: 1199, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const chg = (o) => ({ amount_cents: 1199, billing_interval: 'monthly', source: 'manual', ...o });

// Open periods renew after the frozen today (2026-11-16), so catch-up leaves them alone.
const SEED = {
  services: [
    svc({ id: 's1', name: 'Spotify' }),
    svc({ id: 's2', name: 'Claude' }),
  ],
  periods: [
    { id: 'p1', service_id: 's1', started_on: '2026-08-20', renews_on: '2026-11-20', cancelled_on: null, access_ends_on: null },
    { id: 'p0', service_id: 's1', started_on: '2026-02-03', renews_on: '2026-03-03', cancelled_on: '2026-02-03', access_ends_on: '2026-03-02' },
    { id: 'pe', service_id: 's1', started_on: '2026-01-01', renews_on: '2026-02-01', cancelled_on: '2026-01-01', access_ends_on: '2026-01-31' },
    { id: 'p2', service_id: 's2', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: null, access_ends_on: null },
  ],
  charges: [
    chg({ id: 'c1', service_id: 's1', period_id: 'p1', charged_on: '2026-08-20' }),
    chg({ id: 'c2', service_id: 's1', period_id: 'p1', charged_on: '2026-09-20', source: 'auto' }),
    chg({ id: 'c3', service_id: 's1', period_id: 'p1', charged_on: '2026-10-20', source: 'auto', amount_cents: null }),
    chg({ id: 'c0', service_id: 's1', period_id: 'p0', charged_on: '2026-02-03', amount_cents: 1099 }),
    chg({ id: 'c9', service_id: 's1', period_id: null, charged_on: '2026-01-15', amount_cents: 999 }),
    chg({ id: 'c4', service_id: 's2', period_id: 'p2', charged_on: '2026-11-01', amount_cents: 2000 }),
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
  const fake = (fn, arg) => page.evaluate(fn, arg);
  const isOpen = () => page.evaluate(() => document.getElementById('delp-modal').classList.contains('open'));
  const text = (sel) => page.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const ids = (table) => fake((t) => window.__fake.tables[t].map((r) => r.id).sort().join(','), table);

  await page.goto(BASE + '#/s/s1');
  await page.waitForSelector('.history');
  check('every period has a delete button with a clear label', (await page.$$('.history [data-action="delete-period"]')).length === 3 && (await page.getAttribute('[data-action="delete-period"][data-id="p1"]', 'aria-label')) === 'delete the aug 20 → renewing period');

  // 1. confirmation lists the charges and their total
  await page.click('[data-action="delete-period"][data-id="p1"]');
  check('dialog opens', await isOpen());
  check('dialog names the period, count and total', (await text('#delp-form .del-warning')) === "this removes the aug 20 → renewing period and its 3 charges ($23.98 plus 1 unknown). spend stops counting them. it can't be undone.", await text('#delp-form .del-warning'));
  const listed = await page.$$eval('#delp-charges .charge', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  check('dialog lists each charge', JSON.stringify(listed) === JSON.stringify(['oct 20 amount unknown / mo auto', 'sep 20 $11.99 / mo auto', 'aug 20 $11.99 / mo']), JSON.stringify(listed));
  check('delete dialog 375: no sideways scroll', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/delete-period-375.png` });

  // 2. keep it: nothing happens
  await page.click('#delp-modal .modal-actions [data-action="close-delp"]');
  check('keep it closes without a call', !(await isOpen()) && (await fake(() => window.__fake.calls.filter((c) => c.op === 'rpc').length)) === 0);

  // 3. failure: dialog stays, error shown, nothing removed on the page
  await page.click('[data-action="delete-period"][data-id="p1"]');
  await fake(() => { window.__fake.rpcError = { code: 'P0002', message: 'period not found, or not yours' }; window.__fake.delay = 400; });
  await page.click('#delp-go');
  await page.keyboard.press('Escape');
  check('escape during delete: dialog stays open', await isOpen());
  await page.waitForFunction(() => document.querySelector('#delp-error').textContent);
  check('failure: error in the dialog', (await text('#delp-error')) === "couldn't delete the period: period not found, or not yours");
  check('failure: page still lists the period', (await page.$$('.history [data-id="p1"]')).length === 1 && (await page.isEnabled('#delp-go')));
  await fake(() => { window.__fake.delay = 0; });

  // 4. delete: that period and its charges go, nothing else (acceptance 18)
  await page.click('#delp-go');
  await page.waitForFunction(() => !document.getElementById('delp-modal').classList.contains('open'));
  const call = await fake(() => window.__fake.calls.filter((c) => c.op === 'rpc').pop());
  check('rpc delete_period with the period id', call.name === 'delete_period' && JSON.stringify(call.payload) === JSON.stringify({ p_period_id: 'p1' }));
  check('acceptance 18: period and its charges gone, the rest kept', (await ids('periods')) === 'p0,p2,pe' && (await ids('charges')) === 'c0,c4,c9', `${await ids('periods')} / ${await ids('charges')}`);
  check('toast', (await text('#toast')) === 'deleted the period and its 3 charges');
  const heads = await page.$$eval('.history .period-head .period-dates', (h) => h.map((x) => x.textContent.trim()));
  check('page: period gone, others kept', JSON.stringify(heads) === JSON.stringify(['feb 3 → mar 2', 'jan 1 → jan 31', 'charges in no period']), JSON.stringify(heads));
  check('page: charges of that period gone', !(await text('.history')).includes('sep 20'));
  check('status falls back to the older period; mark subscribed on again', (await text('.detail-status')) === 'inactive · ended mar 2' && await page.isEnabled('[data-action="subscribe"]'));

  // 5. a period with no charges says so
  await page.click('[data-action="delete-period"][data-id="pe"]');
  check('no charges: says so', (await text('#delp-count')) === '(it has no charges)' && (await page.$$('#delp-charges .charge')).length === 0);
  await page.click('#delp-go');
  await page.waitForFunction(() => !document.getElementById('delp-modal').classList.contains('open'));
  check('no charges: toast', (await text('#toast')) === 'deleted the period');

  // 6. fix a start date: delete, then mark subscribed again
  await page.goto(BASE + '#/s/s2');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Claude');
  await page.click('[data-action="delete-period"][data-id="p2"]');
  await page.click('#delp-go');
  await page.waitForFunction(() => !document.getElementById('delp-modal').classList.contains('open'));
  await page.click('[data-action="subscribe"]');
  await page.fill('#sub-date', '2026-11-02');
  await page.click('#sub-save');
  await page.waitForFunction(() => !document.getElementById('sub-modal').classList.contains('open'));
  check('re-subscribe after delete: new period on the right date', (await text('.history .period-dates')) === 'nov 2 → renewing' && (await fake(() => window.__fake.tables.charges.filter((c) => c.service_id === 's2').map((c) => c.charged_on).join(','))) === '2026-11-02');

  // 7. migration missing
  await page.click('[data-action="delete-period"]');
  await fake(() => { window.__fake.rpcError = { code: 'PGRST202', message: 'Could not find the function public.delete_period' }; });
  await page.click('#delp-go');
  await page.waitForFunction(() => document.querySelector('#delp-error').textContent);
  check('missing function: tells you to run migration 002', (await text('#delp-error')).includes('run subs/migrations/002-subscribe-and-delete-period.sql'));
  await page.keyboard.press('Escape');

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
