// Mark cancelled (step 4): the "cancel auto-renew now?" prompt after subscribing a
// rotator, defaults, backfills, validation, blocked writes, acceptance 8.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const SEED = {
  services: [
    svc({ id: 's1', name: 'Netflix', manage_url: 'https://www.netflix.com/cancelplan' }),
    svc({ id: 's2', name: 'Spotify', role: 'keeper', category: 'music' }),
    svc({ id: 's3', name: 'Hulu' }),
    svc({ id: 's4', name: 'Claude', role: 'keeper', category: 'ai' }),
    svc({ id: 's5', name: 'iCloud+', role: 'rotator', manage_url: null, manage_path: 'iPhone Settings → iCloud' }),
  ],
  periods: [
    { id: 'p2', service_id: 's2', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: null, access_ends_on: null },
  ],
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
  const open = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('open'), id);
  const closed = (id) => page.waitForFunction((i) => !document.getElementById(i).classList.contains('open'), id);
  const text = (sel) => page.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const go = async (id, name) => {
    await page.goto(BASE + '#/s/' + id);
    await page.waitForFunction((n) => document.querySelector('.detail-name')?.textContent === n, name);
  };
  const subscribe = async (date) => {
    await page.click('[data-action="subscribe"]');
    if (date) await page.fill('#sub-date', date);
    await page.click('#sub-save');
    await closed('sub-modal');
  };

  // 1. rotate in (SPEC §9): subscribe a rotator → prompt with the manage link → cancel
  await go('s1', 'Netflix');
  await subscribe();
  check('rotator: cancel prompt opens right after subscribing', await open('cancel-modal'));
  check('prompt text and manage link', (await text('#cancel-prompt-text')).startsWith('cancel auto-renew now?') && (await page.getAttribute('#cancel-manage a', 'href')) === 'https://www.netflix.com/cancelplan' && (await page.getAttribute('#cancel-manage a', 'target')) === '_blank');
  check('defaults: cancelled today, access to the day before renewal', (await page.inputValue('#cancel-date')) === '2026-11-16' && (await page.inputValue('#cancel-ends')) === '2026-12-15');
  check('access hint names the renewal', (await text('#cancel-ends-hint')).includes('day before the dec 16 charge'));
  check('cancel dialog 375: no sideways scroll', await noSideScroll());
  await page.screenshot({ path: `${h.SHOTS}/cancel-prompt-375.png` });
  await page.click('#cancel-save');
  await closed('cancel-modal');
  const p1 = await fake(() => window.__fake.tables.periods.find((p) => p.service_id === 's1'));
  check('saved cancelled_on and access_ends_on', p1.cancelled_on === '2026-11-16' && p1.access_ends_on === '2026-12-15', JSON.stringify(p1));
  const upd = await fake(() => window.__fake.calls.filter((c) => c.table === 'periods' && c.op === 'update').pop());
  check('update only matches an uncancelled period', JSON.stringify(upd.filters) === JSON.stringify([['id', p1.id], ['cancelled_on', null]]), JSON.stringify(upd.filters));
  check('acceptance 8: toast and status say active until', (await text('#toast')) === 'cancelled Netflix · active until dec 15' && (await text('.detail-status')) === 'active until dec 15');
  check('history shows the closed period', (await text('.history .period-head')) === 'nov 16 → dec 15 cancelled nov 16 delete…');
  check('mark subscribed available again, mark cancelled gone', (await page.isEnabled('[data-action="subscribe"]')) && (await page.$$('[data-action="cancel"]')).length === 0);

  // 2. keeper: no prompt after subscribing; mark cancelled from the detail with an edited access end
  await go('s4', 'Claude');
  await subscribe();
  check('keeper: no prompt after subscribing', !(await open('cancel-modal')));
  await go('s2', 'Spotify');
  check('open period: mark cancelled is the primary action', await page.isVisible('.btn-primary[data-action="cancel"]'));
  await page.click('[data-action="cancel"]');
  check('no prompt when opened from the detail', await page.isHidden('#cancel-prompt'));
  await page.fill('#cancel-ends', '2026-11-15');
  await page.click('#cancel-save');
  check('access before the cancel date rejected', (await text('[data-for="access_ends_on"]')) === "can't end before you cancelled" && await open('cancel-modal'));
  await page.fill('#cancel-ends', '2026-12-01');
  await page.click('#cancel-save');
  await closed('cancel-modal');
  check('edited access end saved', (await fake(() => window.__fake.tables.periods.find((p) => p.id === 'p2').access_ends_on)) === '2026-12-01');

  // 3. backfill a past rotation: prompt asks whether it ended; defaults to day one
  await go('s3', 'Hulu');
  await subscribe('2026-03-01');
  check('backfill: prompt asks if it ended', (await text('#cancel-prompt-text')).startsWith('did this period end?') && (await text('#cancel-prompt-text')).includes('since apr 1'));
  check('backfill defaults: cancelled on the start day, access to mar 31', (await page.inputValue('#cancel-date')) === '2026-03-01' && (await page.inputValue('#cancel-ends')) === '2026-03-31');
  await page.fill('#cancel-date', '2026-11-16');
  await page.click('#cancel-save');
  check('cancelling after an unrecorded renewal is refused', (await text('[data-for="cancelled_on"]')).startsWith("that's after its apr 1 renewal"));
  await page.fill('#cancel-date', '2026-02-28');
  await page.click('#cancel-save');
  check('cancelling before the start is refused', (await text('[data-for="cancelled_on"]')) === "can't be before it started (mar 1)");
  await page.fill('#cancel-date', '2026-03-01');
  await page.click('#cancel-save');
  await closed('cancel-modal');
  check('backfilled rotation is inactive, ended mar 31', (await text('.detail-status')) === 'inactive · ended mar 31' && (await text('#toast')) === 'cancelled Hulu');

  // 4. "not now" leaves the period open; manage path shown when there's no link
  await go('s5', 'iCloud+');
  await subscribe();
  check('no manage url: prompt shows the manage path', (await text('#cancel-manage')).includes('iPhone Settings → iCloud'));
  await page.click('#cancel-modal .modal-actions [data-action="close-cancel"]');
  check('not now closes the prompt and keeps the period open', !(await open('cancel-modal')) && (await text('.detail-status')) === 'active · renews dec 16');

  // 5. another tab already cancelled it: zero rows → error in the dialog, nothing changed
  await page.click('[data-action="cancel"]');
  await fake(() => { const p = window.__fake.tables.periods.find((x) => x.service_id === 's5'); p.cancelled_on = '2026-11-16'; p.access_ends_on = '2026-12-01'; });
  await page.click('#cancel-save');
  await page.waitForFunction(() => document.querySelector('#cancel-error').textContent);
  check('already cancelled elsewhere: error, dialog stays', (await text('#cancel-error')) === "couldn't mark it cancelled: it's already cancelled, gone, or not yours. reload the page." && await open('cancel-modal'));
  check('other tab\'s dates not overwritten', (await fake(() => window.__fake.tables.periods.find((x) => x.service_id === 's5').access_ends_on)) === '2026-12-01');
  await page.keyboard.press('Escape');

  // dashboard groups after all that
  await page.goto(BASE + '#/');
  await page.waitForSelector('.subs-header');
  const groups = await page.$$eval('.group', (gs) => Object.fromEntries(gs.map((g) => [g.querySelector('.group-title').firstChild.textContent, [...g.querySelectorAll('.row-name')].map((n) => n.textContent)])));
  check('dashboard groups', JSON.stringify(groups) === JSON.stringify({ active: ['Claude', 'iCloud+'], 'active until…': ['Netflix', 'Spotify'], inactive: ['Hulu'] }), JSON.stringify(groups));
  check('dashboard: until date on the cancelled rotator', (await text('.service-row:has-text("Netflix") .row-until')) === 'until dec 15');

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
