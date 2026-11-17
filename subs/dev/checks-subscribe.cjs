// Mark subscribed (step 4): amount, "also set as current price", validation, the
// backfill hint, failed transactions, the missing-migration message, acceptance 7.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const SEED = {
  services: [
    svc({ id: 's1', name: 'Netflix', price_cents: 1799 }),
    svc({ id: 's2', name: 'Google One', role: 'keeper', category: 'storage', billing_interval: 'annual', price_cents: null, price_checked_on: null }),
    svc({ id: 's3', name: 'Hulu' }),
    svc({ id: 's4', name: 'Weekly Thing', billing_interval: 'weekly', price_cents: 299 }),
    svc({ id: 's5', name: 'Old', archived_at: '2026-06-01T12:00:00+00:00' }),
  ],
  periods: [],
  charges: [],
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
  const modalOpen = () => page.evaluate(() => document.getElementById('sub-modal').classList.contains('open'));
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const rpcCalls = () => fake(() => window.__fake.calls.filter((c) => c.op === 'rpc'));
  const go = async (id, name) => {
    await page.goto(BASE + '#/s/' + id);
    await page.waitForFunction((n) => document.querySelector('.detail-name')?.textContent === n, name);
  };

  // 1. defaults, then a different amount without setting the price
  await go('s1', 'Netflix');
  check('inactive service: mark subscribed is the primary action', await page.isVisible('.btn-primary[data-action="subscribe"]:not([disabled])'));
  await page.click('[data-action="subscribe"]');
  check('dialog opens with today and the price', (await modalOpen()) && (await page.inputValue('#sub-date')) === '2026-11-16' && (await page.inputValue('#sub-amount')) === '17.99');
  check('dialog states the billing interval', (await page.textContent('#sub-interval')) === 'monthly');
  check('same amount: no set-price option; renewal hint', (await page.isHidden('#sub-setprice')) && (await page.textContent('#sub-hint')) === 'renews dec 16.');
  check('date picker capped at today', (await page.getAttribute('#sub-date', 'max')) === '2026-11-16');
  await page.fill('#sub-amount', '19.99');
  check('different amount: option shown, unticked, shows price on file', (await page.isVisible('#sub-setprice')) && !(await page.isChecked('[name="set_price"]')) && (await page.textContent('#sub-price-now')) === '$17.99 / mo');
  check('sub dialog 375: no sideways scroll', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/subscribe-375.png` });
  await page.click('#sub-save');
  await page.waitForFunction(() => !document.getElementById('sub-modal').classList.contains('open'));
  const [call] = await rpcCalls();
  check('rpc args', JSON.stringify(call.payload) === JSON.stringify({ p_service_id: 's1', p_started_on: '2026-11-16', p_renews_on: '2026-12-16', p_billing_interval: 'monthly', p_amount_cents: 1999, p_set_price: false }), JSON.stringify(call.payload));
  check('toast', (await page.textContent('#toast')) === 'marked Netflix subscribed');
  check('detail now renewing', (await page.textContent('.detail-status')).trim() === 'active · renews dec 16');
  check('history shows the period and its charge', (await page.textContent('.history .period-head')).replace(/\s+/g, ' ').trim() === 'nov 16 → renewing next charge dec 16 delete…' && (await page.textContent('.history .charge')).replace(/\s+/g, ' ').trim() === 'nov 16 $19.99 / mo');
  check('price unchanged without the tick', (await page.textContent('.kv dd')).startsWith('$17.99 / mo'));

  // acceptance 7: disabled while a period is open
  check('acceptance 7: mark subscribed disabled while renewing, with hint', (await page.isDisabled('[data-action="subscribe"]')) && (await page.textContent('#actions-hint')).includes('before subscribing again'));
  await page.click('[data-action="subscribe"]', { force: true });
  check('forced click on disabled button opens nothing', !(await modalOpen()));

  // 2. unknown price: typing an amount offers the option ticked; saving sets the price
  await go('s2', 'Google One');
  await page.click('[data-action="subscribe"]');
  check('unknown price: amount blank, no option yet', (await page.inputValue('#sub-amount')) === '' && (await page.isHidden('#sub-setprice')));
  await page.fill('#sub-date', '2025-12-02');
  await page.fill('#sub-amount', '50');
  check('unknown price: option shown and ticked', (await page.isVisible('#sub-setprice')) && (await page.isChecked('[name="set_price"]')) && (await page.textContent('#sub-price-now')) === 'unknown');
  check('annual from last year: renews this year, no missed renewals', (await page.textContent('#sub-hint')) === 'renews dec 2.');
  await page.fill('#sub-amount', '0');
  check('$0 trial: option shown but unticked', !(await page.isChecked('[name="set_price"]')));
  await page.fill('#sub-amount', '50');
  await page.click('#sub-save');
  await page.waitForFunction(() => !document.getElementById('sub-modal').classList.contains('open'));
  const g1 = await fake(() => window.__fake.tables.services.find((s) => s.id === 's2'));
  check('set price saves price and checked date together', g1.price_cents === 5000 && g1.price_checked_on === '2025-12-02', JSON.stringify(g1));
  check('detail shows the new price; price-unknown badge gone', (await page.textContent('.kv dd')).startsWith('$50.00 / yr') && !(await page.isVisible('.detail .badge:has-text("price unknown")')));

  // 3. once ticked by hand, the box keeps the user's choice
  await go('s3', 'Hulu');
  await page.click('[data-action="subscribe"]');
  await page.fill('#sub-amount', '20');
  await page.check('[name="set_price"]');
  await page.fill('#sub-amount', '21');
  check('user tick survives later typing', await page.isChecked('[name="set_price"]'));

  // validation
  await page.fill('#sub-date', '2026-11-17');
  await page.fill('#sub-amount', '-1');
  await page.click('#sub-save');
  check('future date and bad amount rejected inline', (await page.textContent('[data-for="date"]')) === "can't be in the future" && (await page.textContent('#sub-form [data-for="amount"]')) === 'enter a price like 12.99' && (await page.getAttribute('#sub-date', 'aria-invalid')) === 'true');
  check('nothing sent for invalid input', (await rpcCalls()).length === 2);

  // backfill hint (acceptance 6)
  await page.fill('#sub-date', '2026-08-16');
  await page.fill('#sub-amount', '15');
  check('backfill hint lists the renewals catch-up will add', (await page.textContent('#sub-hint')) === '3 renewals since (sep 16 to nov 16). the app records them the next time it loads, unless you mark this period cancelled first.', await page.textContent('#sub-hint'));

  // 4. a failed transaction: dialog stays open, error inside it, nothing saved anywhere
  await fake(() => { window.__fake.rpcError = { code: '23514', message: 'new row violates check constraint "charges_amount_cents_check"' }; window.__fake.delay = 400; });
  await page.click('#sub-save');
  await page.keyboard.press('Escape');
  check('escape during save: dialog stays open', await modalOpen());
  await page.waitForFunction(() => document.querySelector('#sub-error').textContent);
  check('failed rpc: error shown in the dialog', (await page.textContent('#sub-error')) === "couldn't mark it subscribed: new row violates check constraint \"charges_amount_cents_check\"");
  check('failed rpc: nothing in the tables', (await fake(() => window.__fake.tables.periods.filter((p) => p.service_id === 's3').length + window.__fake.tables.charges.filter((c) => c.service_id === 's3').length)) === 0);
  check('failed rpc: save button usable again', !(await page.isDisabled('#sub-save')) && (await page.textContent('#sub-save')) === 'mark subscribed');
  await fake(() => { window.__fake.delay = 0; });
  await page.keyboard.press('Escape');
  check('escape closes once idle', !(await modalOpen()));
  check('failed rpc: page still shows no period', (await page.textContent('.history')).includes('no periods yet') && (await page.isEnabled('[data-action="subscribe"]')));

  // 5. migration 002 not run yet: say so
  await page.click('[data-action="subscribe"]');
  await fake(() => { window.__fake.rpcError = { code: 'PGRST202', message: 'Could not find the function public.mark_subscribed' }; });
  await page.click('#sub-save');
  await page.waitForFunction(() => document.querySelector('#sub-error').textContent);
  check('missing function: tells you to run migration 002', (await page.textContent('#sub-error')).includes('run subs/migrations/002-subscribe-and-delete-period.sql'));
  await page.keyboard.press('Escape');

  // 6. too far back for catch-up
  await go('s4', 'Weekly Thing');
  await page.click('[data-action="subscribe"]');
  await page.fill('#sub-date', '1990-01-01');
  await page.click('#sub-save');
  check('too far back rejected', (await page.textContent('[data-for="date"]')).startsWith('too far back'));
  await page.keyboard.press('Escape');

  // 7. back button closes the dialog
  await page.click('[data-action="subscribe"]');
  await page.goBack();
  await page.waitForSelector('.subs-header, .detail');
  check('back button closes the subscribe dialog', !(await modalOpen()));

  // 8. archived: no subscribe action
  await go('s5', 'Old');
  check('archived service offers no mark subscribed', (await page.$$('[data-action="subscribe"]')).length === 0);

  // dashboard reflects new periods (hash navigation: a full reload would reset the fake)
  await page.goto(BASE + '#/');
  await page.waitForSelector('.subs-header');
  const active = await page.$$eval('.group', (gs) => gs.find((g) => g.querySelector('.group-title').firstChild.textContent === 'active')?.querySelectorAll('.row-name').length);
  check('dashboard lists the two subscribed services as active', active === 2);

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
