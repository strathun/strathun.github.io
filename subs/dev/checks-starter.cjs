// Starter list and setup checklist (step 3): one bulk insert, double clicks, a second tab
// loading first, hiding the checklist, blocked browser storage.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
const FAKE = h.FAKE;
let BASE; // set once the server is up
const { check, report } = h.checker();

async function open(browser, { seed = null, init = null } = {}) {
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } }, FAKE);
  // Seed once per context; reloads keep the fake's state via the page, not storage.
  await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    if (s) localStorage.setItem('__seed', JSON.stringify(s));
    else localStorage.removeItem('__seed');
  }, seed);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('#view .subs-header, #view .empty');
  return { ctx, page, errors };
}

// The fake keeps tables in memory, so persist them across a reload by re-seeding.
async function reloadKeepingData(page) {
  await page.evaluate(() => localStorage.setItem('__seed', JSON.stringify(window.__fake.tables)));
  await page.reload();
}

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();

  // load starter list
  {
    const { ctx, page, errors } = await open(browser);
    check('empty state offers starter list + add', (await page.isVisible('[data-action="load-starter"]')) && (await page.isVisible('.empty [data-action="add"]')));
    await page.screenshot({ path: `${h.SHOTS}/empty-starter-375.png` });
    await page.dblclick('[data-action="load-starter"]');
    await page.waitForSelector('.checklist');
    const inserts = await page.evaluate(() => window.__fake.calls.filter((c) => c.op === 'insert'));
    check('double click → exactly one insert', inserts.length === 1, String(inserts.length));
    check('one bulk insert of 13 rows', inserts[0].payload.length === 13);
    check('every row has all 12 columns', inserts[0].payload.every((r) => Object.keys(r).length === 12 && 'manage_path' in r && 'price_checked_on' in r));
    check('13 services shown, count 13', (await page.$$('.service-row')).length === 13 && (await page.textContent('.subs-title small')) === '13');
    check('toast', (await page.textContent('#toast')) === 'loaded 13 services');
    check('checklist shows pricing progress', (await page.textContent('.checklist .progress')) === '2 of 13 priced');
    // Mark subscribed exists now; mark cancelled (and so backfilling) arrive next.
    const later = await page.$$eval('.checklist li', (lis) => lis.map((li) => li.querySelector('.later') !== null));
    check('only unbuilt items marked step 4', JSON.stringify(later) === JSON.stringify([false, false, true, true]), JSON.stringify(later));
    check('starter button gone once services exist', (await page.$$('[data-action="load-starter"]')).length === 0);
    check('375: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.screenshot({ path: `${h.SHOTS}/checklist-375.png`, fullPage: true });

    // dismiss persists across reload, reopen works
    await page.click('[data-action="dismiss-checklist"]');
    check('hide removes checklist', (await page.$$('.checklist')).length === 0 && (await page.isVisible('[data-action="show-checklist"]')));
    await reloadKeepingData(page);
    await page.waitForSelector('.subs-header');
    check('hidden checklist stays hidden after reload', (await page.$$('.checklist')).length === 0);
    await page.click('[data-action="show-checklist"]');
    check('show brings it back', await page.isVisible('.checklist'));

    // price everything → item 1 done
    await page.evaluate(() => window.__fake.tables.services.forEach((s) => { s.price_cents ??= 999; }));
    await reloadKeepingData(page);
    await page.waitForSelector('.checklist');
    check('all priced → item 1 done', (await page.textContent('.checklist .progress')) === '13 of 13 priced' && (await page.$$('.checklist li.done')).length === 1);
    check('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // another tab loaded it first → 23505 → reload, no partial insert
  {
    const { ctx, page, errors } = await open(browser);
    await page.evaluate(() => window.__fake.tables.services.push({ id: 'other-tab', name: 'Netflix', role: 'rotator', billing_interval: 'monthly', price_cents: null, archived_at: null, url_verified: true, cancel_lead_days: 1 }));
    await page.click('[data-action="load-starter"]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent);
    check('conflict: friendly toast', (await page.textContent('#toast')) === 'the starter list was already loaded');
    check('conflict: nothing partially inserted', (await page.evaluate(() => window.__fake.tables.services.length)) === 1);
    check('conflict: page reloaded to what is really there', (await page.$$('.service-row')).length === 1);
    check('conflict: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // storage blocked: page still works, checklist just shows
  {
    const block = () => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (k) { if (String(k).startsWith('subs.')) throw new Error('blocked'); return get.call(this, k); };
      Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('subs.')) throw new Error('blocked'); return set.call(this, k, v); };
    };
    const seed = { services: [{ id: 'a', name: 'Netflix', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', url_verified: true, cancel_lead_days: 1, archived_at: null }], periods: [] };
    const { ctx, page, errors } = await open(browser, { seed, init: block });
    check('blocked storage: checklist renders', await page.isVisible('.checklist'));
    await page.click('[data-action="dismiss-checklist"]');
    check('blocked storage: hide does not crash', errors.length === 0 && (await page.$$('.service-row')).length === 1, errors.join('; '));
    await ctx.close();
  }

  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
