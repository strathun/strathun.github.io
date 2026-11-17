// Edit charge (step 4, SPEC §8.3, §9 keeper renewal): amount and date, "also set as
// current price", collisions, no-op saves, partial failures and retries.
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
    svc({ id: 's2', name: 'Claude', price_cents: null, price_checked_on: null }),
  ],
  periods: [
    { id: 'p1', service_id: 's1', started_on: '2026-08-20', renews_on: '2026-11-20', cancelled_on: null, access_ends_on: null },
    { id: 'p2', service_id: 's2', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: null, access_ends_on: null },
  ],
  charges: [
    chg({ id: 'c1', service_id: 's1', period_id: 'p1', charged_on: '2026-08-20' }),
    chg({ id: 'c2', service_id: 's1', period_id: 'p1', charged_on: '2026-09-20', source: 'auto' }),
    chg({ id: 'c3', service_id: 's1', period_id: 'p1', charged_on: '2026-10-20', source: 'auto' }),
    chg({ id: 'c4', service_id: 's2', period_id: 'p2', charged_on: '2026-11-01', amount_cents: null }),
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
  const isOpen = () => page.evaluate(() => document.getElementById('chg-modal').classList.contains('open'));
  const closed = () => page.waitForFunction(() => !document.getElementById('chg-modal').classList.contains('open'));
  const text = (sel) => page.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const row = (id) => fake((i) => window.__fake.tables.charges.find((c) => c.id === i), id);
  const service = (id) => fake((i) => window.__fake.tables.services.find((s) => s.id === i), id);
  const writes = () => fake(() => window.__fake.calls.filter((c) => c.op !== 'select').length);
  const editBtn = (id) => `[data-action="edit-charge"][data-id="${id}"]`;
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  await page.goto(BASE + '#/s/s1');
  await page.waitForSelector('.history');
  check('every charge has an edit button with a clear label', (await page.$$('.history [data-action="edit-charge"]')).length === 3 && (await page.getAttribute(editBtn('c3'), 'aria-label')) === 'edit the oct 20 charge');

  // 1. §9 keeper renewal: the price went up; fix the auto charge and set the price
  await page.click(editBtn('c3'));
  check('dialog prefilled; auto charges explained', (await isOpen()) && (await page.inputValue('#chg-date')) === '2026-10-20' && (await page.inputValue('#chg-amount')) === '11.99' && (await text('#chg-lead')).startsWith('recorded automatically'));
  check('unchanged amount: no set-price option', await page.isHidden('#chg-setprice'));
  await page.fill('#chg-amount', '12.99');
  check('changed amount: option offered, unticked, shows price on file', (await page.isVisible('#chg-setprice')) && !(await page.isChecked('#chg-form [name="set_price"]')) && (await text('#chg-price-now')) === '$11.99 / mo');
  await page.screenshot({ path: `${h.SHOTS}/edit-charge-375.png` });
  check('charge dialog 375: no sideways scroll', await noSideScroll());
  await page.check('#chg-form [name="set_price"]');
  await page.click('#chg-save');
  await closed();
  const c3 = await row('c3');
  const s1 = await service('s1');
  check('charge amount saved, source and date kept', c3.amount_cents === 1299 && c3.source === 'auto' && c3.charged_on === '2026-10-20', JSON.stringify(c3));
  check('price set, checked on the charge date', s1.price_cents === 1299 && s1.price_checked_on === '2026-10-20', JSON.stringify(s1));
  const ops = await fake(() => window.__fake.calls.filter((c) => c.op === 'update').map((c) => [c.table, JSON.stringify(c.payload)]));
  check('price saved first, then only the changed charge column', JSON.stringify(ops) === JSON.stringify([['services', '{"price_cents":1299,"price_checked_on":"2026-10-20"}'], ['charges', '{"amount_cents":1299}']]), JSON.stringify(ops));
  check('page shows both', (await text(`.charge:has(${editBtn('c3')})`)) === 'oct 20 $12.99 / mo auto edit' && (await text('.kv dd')).startsWith('$12.99 / mo · checked oct 20'));
  check('toast', (await text('#toast')) === "saved the charge and set Spotify's price");

  // 2. no change: closes without writing
  const before = await writes();
  await page.click(editBtn('c1'));
  await page.click('#chg-save');
  await closed();
  check('nothing changed: closes, no write', (await writes()) === before);

  // 3. validation: a date another charge in the period has; the future; bad amount
  await page.click(editBtn('c1'));
  await page.fill('#chg-date', '2026-09-20');
  await page.click('#chg-save');
  check('same date as another charge in the period refused', (await text('#chg-form [data-for="charged_on"]')) === 'this period already has a charge on that date');
  await page.fill('#chg-date', '2026-11-17');
  await page.fill('#chg-amount', 'abc');
  await page.click('#chg-save');
  check('future date and bad amount refused', (await text('#chg-form [data-for="charged_on"]')) === "can't be in the future" && (await text('#chg-form [data-for="amount"]')) === 'enter a price like 12.99');
  check('nothing sent', (await writes()) === before);

  // 4. move the date; blank the amount → unknown
  await page.fill('#chg-date', '2026-08-21');
  await page.fill('#chg-amount', '');
  await page.click('#chg-save');
  await closed();
  const c1 = await row('c1');
  check('date moved and amount unknown', c1.charged_on === '2026-08-21' && c1.amount_cents === null, JSON.stringify(c1));
  check('page shows amount unknown', (await text(`.charge:has(${editBtn('c1')})`)) === 'aug 21 amount unknown / mo edit');

  // 5. charge save fails after the price saved: say so; retry only sends the charge
  await page.click(editBtn('c2'));
  await page.fill('#chg-amount', '13.49');
  await page.check('#chg-form [name="set_price"]');
  await fake(() => { window.__fake.failNext = { table: 'charges', op: 'update', code: '08006', message: 'connection failure' }; });
  await page.click('#chg-save');
  await page.waitForFunction(() => document.querySelector('#chg-error').textContent);
  check('partial failure: dialog says the price saved but the charge did not', (await text('#chg-error')) === "price updated, but couldn't save the charge: connection failure" && await isOpen());
  check('partial failure: price saved, charge unchanged', (await service('s1')).price_cents === 1349 && (await row('c2')).amount_cents === 1199);
  check('partial failure: page behind shows the new price; option now hidden', (await text('.kv dd')).startsWith('$13.49 / mo') && await page.isHidden('#chg-setprice'));
  const mark = await fake(() => window.__fake.calls.length);
  await page.click('#chg-save');
  await closed();
  const retry = await fake((m) => window.__fake.calls.slice(m).filter((c) => c.op === 'update').map((c) => c.table), mark);
  check('retry sends only the charge', JSON.stringify(retry) === JSON.stringify(['charges']) && (await row('c2')).amount_cents === 1349, JSON.stringify(retry));

  // 6. price save fails first: nothing saved, the error says what
  await page.click(editBtn('c1'));
  await page.fill('#chg-amount', '20');
  await page.check('#chg-form [name="set_price"]');
  await fake(() => { window.__fake.failNext = { table: 'services', op: 'update', code: '08006', message: 'connection failure' }; window.__fake.delay = 400; });
  await page.click('#chg-save');
  await page.keyboard.press('Escape');
  check('escape during save: dialog stays', await isOpen());
  await page.waitForFunction(() => document.querySelector('#chg-error').textContent);
  check('price failure: nothing saved', (await text('#chg-error')) === "couldn't update the price: connection failure" && (await row('c1')).amount_cents === null && (await service('s1')).price_cents === 1349);
  await fake(() => { window.__fake.delay = 0; });
  await page.keyboard.press('Escape');

  // 7. unknown price: filling in an unknown charge offers the option ticked
  await page.goto(BASE + '#/s/s2');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Claude');
  await page.click(editBtn('c4'));
  check('unknown charge: manual lead text', (await text('#chg-lead')) === 'make it match your statement.');
  await page.fill('#chg-amount', '20');
  check('unknown price: option ticked by default', (await page.isVisible('#chg-setprice')) && await page.isChecked('#chg-form [name="set_price"]'));
  await page.click('#chg-save');
  await closed();
  const s2 = await service('s2');
  check('unknown price filled from the charge', s2.price_cents === 2000 && s2.price_checked_on === '2026-11-01' && (await row('c4')).amount_cents === 2000);
  check('price-unknown badge gone', !(await page.isVisible('.detail .badge:has-text("price unknown")')));

  // 8. back button closes the dialog
  await page.click(editBtn('c4'));
  await page.goBack();
  await page.waitForSelector('.subs-header, .detail');
  check('back button closes the charge dialog', !(await isOpen()));

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
