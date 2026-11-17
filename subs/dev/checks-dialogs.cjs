// Dialog and routing edge cases (step 3 review fixes): Escape or the back button during a
// slow save or delete, malformed hashes, archive/restore error text, comma decimals.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
const FAKE = h.FAKE;
let BASE; // set once the server is up
const { check, report } = h.checker();
const svc = (o) => ({ category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1500, price_checked_on: '2026-11-01', manage_url: 'https://example.com/account', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null, ...o });
const SEED = {
  services: [
    svc({ id: 's1', name: 'Netflix' }),
    svc({ id: 's2', name: 'Hulu' }),
    svc({ id: 's3', name: 'Spacey ', archived_at: '2026-06-01T12:00:00+00:00' }),
    svc({ id: 's4', name: 'Disney+', archived_at: '2026-06-01T12:00:00+00:00' }),
  ],
  periods: [],
};

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();
  const ctx = await h.newContext(browser, { viewport: { width: 375, height: 800 } }, FAKE);
  await ctx.addInitScript((s) => localStorage.setItem('__seed', JSON.stringify(s)), SEED);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fake = (fn, arg) => page.evaluate(fn, arg);
  const modalOpen = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('open'), id);

  await page.goto(BASE);
  await page.waitForSelector('.subs-header');

  // 1. Escape during an in-flight save that fails → dialog stays, error visible
  await page.click('.service-row:has-text("Netflix")');
  await page.click('[data-action="edit"]');
  await fake(() => { window.__fake.delay = 600; window.__fake.blockWrites = true; });
  await page.fill('#f-notes', 'x');
  await page.click('#svc-save');
  await page.keyboard.press('Escape');
  await page.click('[data-action="close-form"].close-btn');
  check('escape / × during save: dialog stays open', await modalOpen('svc-modal'));
  await page.waitForFunction(() => document.querySelector('#svc-error').textContent);
  check('failed save error is visible in the open dialog', (await modalOpen('svc-modal')) && (await page.textContent('#svc-error')).startsWith("couldn't save the service"));
  await page.keyboard.press('Escape');
  check('escape works again once the save ends', !(await modalOpen('svc-modal')));

  // 2. back button with the edit dialog open → closes it
  await fake(() => { window.__fake.delay = 0; window.__fake.blockWrites = false; });
  await page.click('[data-action="edit"]');
  await page.goBack();
  await page.waitForSelector('.subs-header');
  check('back button closes the edit dialog', !(await modalOpen('svc-modal')));

  // 3. back button during a successful save → stays until done, then closes and saves
  await page.click('.service-row:has-text("Hulu")');
  await page.click('[data-action="edit"]');
  await fake(() => { window.__fake.delay = 600; });
  await page.fill('#f-price', '12,99'); // comma decimal (finding 7)
  await page.click('#svc-save');
  await page.goBack();
  await page.waitForSelector('.subs-header');
  check('back during save: dialog still open while saving', await modalOpen('svc-modal'));
  await page.waitForFunction(() => !document.getElementById('svc-modal').classList.contains('open'));
  check('back during save: save lands, toast shown', (await page.textContent('#toast')) === 'saved Hulu');
  check('comma decimal saved as cents', (await fake(() => window.__fake.tables.services.find((s) => s.id === 's2').price_cents)) === 1299);
  check('dashboard row shows the new price', (await page.textContent('.service-row:has-text("Hulu") .row-price')) === '$12.99 / mo');
  await fake(() => { window.__fake.delay = 0; });

  // 4. malformed hash → not found, no errors
  await page.goto(BASE + '#/s/%');
  await page.waitForSelector('.empty');
  check('#/s/% shows not found', (await page.textContent('.empty')).includes("doesn't exist"));
  await page.evaluate(() => { location.hash = '#/s/%E0%A4%A'; });
  await page.waitForTimeout(200);
  check('malformed hash on hashchange: not found, no page error', (await page.textContent('.empty')).includes("doesn't exist") && errors.length === 0, errors.join('; '));

  // 5. archive / restore errors name their action
  await page.goto(BASE + '#/s/s1');
  await page.waitForSelector('[data-action="archive"]');
  await fake(() => { window.__fake.blockWrites = true; });
  await page.click('[data-action="archive"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith("couldn't"));
  check('archive failure says archive', (await page.textContent('#toast')) === "couldn't archive the service: not found, or not yours");
  await page.goto(BASE + '#/s/s4');
  await page.waitForSelector('[data-action="restore"]');
  await page.click('[data-action="restore"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('restore'));
  check('restore failure says restore', (await page.textContent('#toast')) === "couldn't restore the service: not found, or not yours");
  check('restore button usable again after failure', !(await page.isDisabled('[data-action="restore"]')));
  await fake(() => { window.__fake.blockWrites = false; });
  await page.click('[data-action="restore"]');
  await page.waitForSelector('[data-action="archive"]');
  check('restore succeeds after unblock', (await fake(() => window.__fake.tables.services.find((s) => s.id === 's4').archived_at)) === null);
  await page.click('[data-action="archive"]');
  await page.waitForSelector('[data-action="restore"]');
  check('archive via shared function works', typeof (await fake(() => window.__fake.tables.services.find((s) => s.id === 's4').archived_at)) === 'string');

  // 6. delete a name with outer whitespace; escape during in-flight delete keeps dialog
  await page.goto(BASE + '#/s/s3');
  await page.waitForSelector('[data-action="delete"]');
  await page.click('[data-action="delete"]');
  await page.fill('#del-confirm', 'Spacey');
  check('trimmed name enables delete', !(await page.isDisabled('#del-go')));
  await fake(() => { window.__fake.delay = 600; });
  await page.click('#del-go');
  await page.keyboard.press('Escape');
  check('escape during delete: dialog stays open', await modalOpen('del-modal'));
  await page.waitForFunction(() => location.hash === '#/');
  check('delete completes and returns to dashboard', !(await modalOpen('del-modal')) && !(await fake(() => window.__fake.tables.services.some((s) => s.id === 's3'))));

  check('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
