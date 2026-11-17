// Service detail, archive, restore and permanent delete (step 3).
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
const FAKE = h.FAKE;
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const SEED = {
  services: [
    svc({ id: 's1', name: 'Spotify', role: 'keeper', category: 'music', manage_url: 'https://www.spotify.com/account/', url_verified: false, help_url: 'https://support.spotify.com/x' }),
    svc({ id: 's2', name: 'Netflix' }),
    svc({ id: 's3', name: 'iCloud+', role: 'keeper', category: 'storage', manage_url: null, manage_path: 'iPhone Settings → [name] → iCloud', notes: 'Cancel = free plan.\nTakes effect at period end.', cancel_lead_days: 2 }),
    svc({ id: 's4', name: 'Evil', manage_url: 'javascript:alert(1)', help_url: 'javascript:alert(2)' }),
    svc({ id: 's5', name: 'Disney+', archived_at: '2026-06-01T12:00:00+00:00' }),
  ],
  periods: [
    { id: 'p1', service_id: 's1', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: null, access_ends_on: null },
    { id: 'p2', service_id: 's2', started_on: '2026-11-10', renews_on: '2026-12-10', cancelled_on: '2026-11-10', access_ends_on: '2026-12-09' },
    { id: 'p5', service_id: 's5', started_on: '2026-03-01', renews_on: '2026-04-01', cancelled_on: '2026-03-01', access_ends_on: '2026-03-31' },
  ],
};

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } }, FAKE);
  await ctx.addInitScript((s) => localStorage.setItem('__seed', JSON.stringify(s)), SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // deep link straight to a detail page
  await page.goto(BASE + '#/s/s1');
  await page.waitForSelector('.detail');
  check('deep link renders detail', (await page.textContent('.detail-name')) === 'Spotify');
  check('renewing status text', (await page.textContent('.detail-status')).trim() === 'active · renews dec 1');
  const manage = await page.getAttribute('a:has-text("open manage page")', 'href');
  check('manage button links out', manage === 'https://www.spotify.com/account/' && (await page.getAttribute('a:has-text("open manage page")', 'target')) === '_blank' && (await page.getAttribute('a:has-text("open manage page")', 'rel')).includes('noopener'));
  check('help link shown', (await page.getAttribute('a:has-text("how to cancel")', 'href')) === 'https://support.spotify.com/x');
  check('unverified link explained', await page.isVisible('text=this link is a best guess'));
  check('D1: archive disabled while renewing, with hint', (await page.isDisabled('[data-action="archive"]')) && await page.isVisible('#actions-hint'));
  await page.click('[data-action="archive"]', { force: true });
  check('D1: forced click on disabled archive does nothing', !(await page.evaluate(() => window.__fake.calls.some((c) => c.op === 'update'))));
  check('no restore/delete on a live service', (await page.$$('[data-action="restore"], [data-action="delete"]')).length === 0);
  await page.screenshot({ path: `${h.SHOTS}/detail-renewing-375.png`, fullPage: true });
  check('detail 375: no sideways scroll', await noSideScroll());

  // manage path + notes + lead days
  await page.goto(BASE + '#/s/s3');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'iCloud+');
  check('manage path shown when no url', (await page.textContent('.manage-path')).includes('iPhone Settings → [name] → iCloud') && (await page.$$('a:has-text("open manage page")')).length === 0);
  check('notes keep line breaks', (await page.$eval('.notes', (n) => getComputedStyle(n).whiteSpace)) === 'pre-wrap');
  check('lead days pluralised', (await page.textContent('.kv')).includes('2 days before renewal'));
  check('inactive service can be archived', !(await page.isDisabled('[data-action="archive"]')));

  // unsafe urls stored in the db are never links
  await page.goto(BASE + '#/s/s4');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Evil');
  check('javascript: urls not rendered as links', (await page.$$('.detail a[href^="javascript"]')).length === 0 && await page.isVisible('text=no manage link yet'));

  // unknown id
  await page.goto(BASE + '#/s/nope');
  await page.waitForSelector('.empty');
  check('unknown id: not-found message + back link', (await page.textContent('.empty')).includes("doesn't exist") && await page.isVisible('a.back'));

  // archive an ending service → hidden from dashboard, shown under toggle
  await page.goto(BASE + '#/s/s2');
  await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Netflix');
  check('ending status text', (await page.textContent('.detail-status')).trim() === 'active until dec 9');
  await page.click('[data-action="archive"]');
  await page.waitForSelector('[data-action="restore"]');
  const stored = await page.evaluate(() => window.__fake.tables.services.find((s) => s.id === 's2').archived_at);
  check('archive sets archived_at', typeof stored === 'string' && !Number.isNaN(Date.parse(stored)));
  check('archived detail: restore + delete offered, no edit/archive', (await page.$$('[data-action="edit"], [data-action="archive"]')).length === 0 && await page.isVisible('[data-action="delete"]'));
  check('archived status text', (await page.textContent('.detail-status')).trim().startsWith('archived nov'));
  check('archive toast', (await page.textContent('#toast')) === 'archived Netflix');
  await page.click('a.back');
  await page.waitForSelector('.subs-header');
  const visibleNames = await page.$$eval('.service-row', (r) => r.map((x) => x.querySelector('.row-name').textContent));
  check('archived services hidden from dashboard', !visibleNames.includes('Netflix') && !visibleNames.includes('Disney+'), visibleNames.join(','));
  check('count excludes archived', (await page.textContent('.subs-title small')) === '3');
  check('toggle shows archived count', (await page.textContent('[data-action="toggle-archived"]')).trim() === 'show archived (2)');
  await page.click('[data-action="toggle-archived"]');
  const archivedNames = await page.$$eval('.service-row.is-archived .row-name', (r) => r.map((x) => x.textContent));
  check('toggle lists archived, sorted', archivedNames.join(',') === 'Disney+,Netflix', archivedNames.join(','));
  check('archived rows show no "until" or badges', (await page.$$('.is-archived .row-until, .is-archived .badge')).length === 0);
  await page.screenshot({ path: `${h.SHOTS}/dashboard-archived-375.png`, fullPage: true });

  // restore from detail
  await page.click('.service-row.is-archived:has-text("Netflix")');
  await page.click('[data-action="restore"]');
  await page.waitForSelector('[data-action="archive"]');
  check('restore clears archived_at', (await page.evaluate(() => window.__fake.tables.services.find((s) => s.id === 's2').archived_at)) === null);
  await page.goBack();
  await page.waitForSelector('.subs-header');
  check('restored service back on dashboard', (await page.$$eval('.service-row:not(.is-archived) .row-name', (r) => r.map((x) => x.textContent))).includes('Netflix'));

  // delete flow on Disney+
  await page.click('.service-row.is-archived:has-text("Disney+")');
  await page.click('[data-action="delete"]');
  check('delete dialog open, button disabled', (await page.isVisible('#del-modal.open')) && (await page.isDisabled('#del-go')));
  await page.fill('#del-confirm', 'disney+');
  check('wrong case keeps it disabled', await page.isDisabled('#del-go'));
  await page.fill('#del-confirm', 'Disney+ ');
  check('exact name (trimmed) enables it', !(await page.isDisabled('#del-go')));
  await page.screenshot({ path: `${h.SHOTS}/delete-375.png` });
  await page.evaluate(() => { window.__fake.blockWrites = true; });
  await page.click('#del-go');
  await page.waitForFunction(() => document.querySelector('#del-error').textContent);
  check('blocked delete: error shown, dialog stays', (await page.textContent('#del-error')) === "couldn't delete the service: not found, or not yours" && await page.isVisible('#del-modal.open'));
  await page.evaluate(() => { window.__fake.blockWrites = false; });
  await page.click('#del-go');
  await page.waitForFunction(() => location.hash === '#/');
  check('delete removes the row in the db', !(await page.evaluate(() => window.__fake.tables.services.some((s) => s.id === 's5'))));
  check('delete returns to dashboard with toast', (await page.textContent('#toast')) === 'deleted Disney+' && !(await page.isVisible('#del-modal.open')));
  check('no archived left → toggle gone', (await page.$$('[data-action="toggle-archived"]')).length === 0);
  check('delete call was by id', await page.evaluate(() => { const c = window.__fake.calls.filter((x) => x.op === 'delete'); return c.length === 2 && c.every((x) => x.table === 'services' && x.filters[0][0] === 'id' && x.filters[0][1] === 's5'); }));

  check('no page errors or dialogs', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
