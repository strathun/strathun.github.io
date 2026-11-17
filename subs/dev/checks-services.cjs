// Services list and add/edit form (step 3): grouping, badges, escaping, form validation,
// the price-checked-date rule, duplicate names, blocked writes, load failure, 375px layout.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');
const FAKE = h.FAKE;
let BASE; // set once the server is up
const { check, report } = h.checker();

const SEED = {
  services: [
    { id: 's1', name: 'Spotify', category: 'music', role: 'keeper', billing_interval: 'monthly', price_cents: 1199, price_checked_on: '2026-11-01', manage_url: 'https://www.spotify.com/account/subscription/', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null },
    { id: 's2', name: 'Netflix', category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1799, price_checked_on: '2026-03-01', manage_url: 'https://www.netflix.com/cancelplan', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null },
    { id: 's3', name: 'Google One', category: 'storage', role: 'keeper', billing_interval: 'annual', price_cents: null, price_checked_on: null, manage_url: null, manage_path: 'Google One app → Settings', help_url: null, url_verified: false, cancel_lead_days: 1, notes: 'line one\nline two', archived_at: null },
    { id: 's4', name: 'A Service With A Really Quite Long Name Plus', category: null, role: 'rotator', billing_interval: 'weekly', price_cents: 499, price_checked_on: null, manage_url: null, manage_path: null, help_url: null, url_verified: false, cancel_lead_days: 1, notes: null, archived_at: null },
    { id: 's5', name: 'Disney+', category: 'video', role: 'rotator', billing_interval: 'monthly', price_cents: 1599, price_checked_on: '2026-10-01', manage_url: null, manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: '2026-06-01T00:00:00+00:00' },
    { id: 's6', name: '<img src=x onerror=alert(1)>', category: 'other', role: 'rotator', billing_interval: 'monthly', price_cents: 100, price_checked_on: '2026-11-01', manage_url: 'javascript:alert(1)', manage_path: null, help_url: null, url_verified: true, cancel_lead_days: 1, notes: null, archived_at: null },
  ],
  periods: [
    { id: 'p1', service_id: 's1', started_on: '2026-11-01', renews_on: '2026-12-01', cancelled_on: null, access_ends_on: null },
    { id: 'p2', service_id: 's2', started_on: '2026-11-10', renews_on: '2026-12-10', cancelled_on: '2026-11-10', access_ends_on: '2026-12-09' },
  ],
};

async function open(browser, { seed = null, viewport = { width: 375, height: 800 } } = {}) {
  const ctx = await h.newContext(browser, { viewport });
  await ctx.addInitScript((s) => { if (s) localStorage.setItem('__seed', JSON.stringify(s)); else localStorage.removeItem('__seed'); }, seed);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(BASE);
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForFunction(() => !document.querySelector('.loading-msg'));
  return { ctx, page, errors };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

(async () => {
  BASE = (await h.baseUrl()) + '/subs/';
  const browser = await chromium.launch();

  // 1. empty state
  {
    const { ctx, page, errors } = await open(browser);
    check('empty: shows "no services yet"', await page.isVisible('text=no services yet.'));
    await page.screenshot({ path: `${h.SHOTS}/empty-375.png`, fullPage: true });
    check('empty: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // 2. seeded dashboard, phone width
  {
    const { ctx, page, errors } = await open(browser, { seed: SEED });
    const groups = await page.$$eval('.group', (gs) => gs.map((g) => [g.querySelector('.group-title').firstChild.textContent, [...g.querySelectorAll('.row-name')].map((n) => n.textContent)]));
    check('groups and order', JSON.stringify(groups) === JSON.stringify([
      ['active', ['Spotify']],
      ['active until…', ['Netflix']],
      ['inactive', ['<img src=x onerror=alert(1)>', 'A Service With A Really Quite Long Name Plus', 'Google One']],
    ]), JSON.stringify(groups));
    check('archived Disney+ hidden', !(await page.isVisible('text=Disney+')));
    check('count excludes archived', (await page.textContent('.subs-title small')) === '5');
    check('ending row shows until date', (await page.textContent('.service-row:has-text("Netflix") .row-until')) === 'until dec 9');
    const badges = await page.$$eval('.service-row', (rows) => rows.map((r) => [r.querySelector('.row-name').textContent, [...r.querySelectorAll('.badge')].map((b) => b.textContent), r.querySelector('.row-price').textContent]));
    const byName = Object.fromEntries(badges.map(([n, b, p]) => [n, { b, p }]));
    check('Netflix: stale price → check price', JSON.stringify(byName.Netflix.b) === '["check price"]');
    check('Google One: verify link + price unknown, price "— / yr"', JSON.stringify(byName['Google One']) === JSON.stringify({ b: ['verify link', 'price unknown'], p: '— / yr' }));
    check('long name: never checked → check price, weekly', JSON.stringify(byName['A Service With A Really Quite Long Name Plus']) === JSON.stringify({ b: ['verify link', 'check price'], p: '$4.99 / wk' }));
    check('Spotify: no badges, $11.99 / mo', JSON.stringify(byName.Spotify) === JSON.stringify({ b: [], p: '$11.99 / mo' }));
    check('html in a name is escaped', (await page.$$('.row-name img')).length === 0);
    check('375px: no sideways page scroll', await noSideScroll(page));
    await page.screenshot({ path: `${h.SHOTS}/dashboard-375.png`, fullPage: true });

    // open edit form for Netflix, prefilled
    await page.click('.service-row:has-text("Netflix")');
    await page.waitForSelector('.detail');
    check('row opens detail via hash', (await page.evaluate(() => location.hash)) === '#/s/s2');
    await page.click('[data-action="edit"]');
    const v = await page.evaluate(() => { const f = document.querySelector('#svc-form').elements; return { name: f.name.value, role: f.namedItem('role').value, interval: f.billing_interval.value, price: f.price.value, checked: f.price_checked_on.value }; });
    check('edit form prefilled', JSON.stringify(v) === JSON.stringify({ name: 'Netflix', role: 'rotator', interval: 'monthly', price: '17.99', checked: '2026-03-01' }), JSON.stringify(v));
    check('375px with modal: no sideways page scroll', await noSideScroll(page));
    await page.screenshot({ path: `${h.SHOTS}/edit-modal-375.png` });

    // change price → saved, checked date becomes today, badge gone
    await page.fill('#f-price', '19.99');
    await page.click('#svc-save');
    await page.waitForFunction(() => !document.querySelector('#svc-modal').classList.contains('open'), null, { timeout: 5000 });
    const stored = await page.evaluate(() => window.__fake.tables.services.find((s) => s.id === 's2'));
    const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    check('edit: price saved as cents', stored.price_cents === 1999);
    check('edit: price change sets checked date to today (D2)', stored.price_checked_on === today, stored.price_checked_on);
    check('edit: detail re-rendered with new price, badge gone', (await page.textContent('.kv dd')).startsWith('$19.99 / mo') && (await page.$$('.detail .badge')).length === 0);
    await page.goBack();
    await page.waitForSelector('.subs-header');
    check('back button returns to dashboard', (await page.evaluate(() => location.hash)) === '');
    check('dashboard row updated', (await page.textContent('.service-row:has-text("Netflix") .row-price')) === '$19.99 / mo');

    // duplicate names: live and archived
    await page.click('[data-action="add"]');
    await page.fill('#f-name', 'spotify ');
    await page.click('#svc-save');
    check('add: live duplicate name rejected', (await page.textContent('[data-for="name"]')) === 'you already have "Spotify".');
    await page.fill('#f-name', 'DISNEY+');
    await page.click('#svc-save');
    check('add: archived duplicate says restore', (await page.textContent('[data-for="name"]')).includes('archived service is named "Disney+". restore it instead.'));

    // validation errors shown on fields, focus on first
    await page.fill('#f-name', '');
    await page.fill('#f-price', '12.999');
    await page.fill('#f-manage', 'javascript:alert(1)');
    await page.fill('#f-lead', 'two');
    await page.click('#svc-save');
    const errs = await page.$$eval('.field-error', (els) => Object.fromEntries(els.filter((e) => e.textContent).map((e) => [e.dataset.for, e.textContent])));
    check('add: errors on name, price, manage_url, lead days', JSON.stringify(Object.keys(errs).sort()) === JSON.stringify(['cancel_lead_days', 'manage_url', 'name', 'price']), JSON.stringify(errs));
    check('add: focus moves to first bad field', (await page.evaluate(() => document.activeElement.id)) === 'f-name');
    check('add: invalid fields marked aria-invalid', (await page.$$('[aria-invalid="true"]')).length === 4);
    await page.screenshot({ path: `${h.SHOTS}/add-errors-375.png` });

    // valid add
    await page.fill('#f-name', 'Paramount+');
    await page.fill('#f-price', '$7.99');
    await page.fill('#f-manage', 'https://www.paramountplus.com/account/');
    await page.fill('#f-lead', '');
    await page.click('label[for="f-role-keeper"]');
    await page.selectOption('#f-category', 'video');
    await page.click('#svc-save');
    await page.waitForFunction(() => !document.querySelector('#svc-modal').classList.contains('open'), null, { timeout: 5000 });
    const added = await page.evaluate(() => window.__fake.tables.services.find((s) => s.name === 'Paramount+'));
    const insertCall = await page.evaluate(() => window.__fake.calls.find((c) => c.op === 'insert').payload[0]);
    check('add: row stored with cents, role, lead default', added && added.price_cents === 799 && added.role === 'keeper' && added.cancel_lead_days === 1 && added.category === 'video' && added.price_checked_on === today, JSON.stringify(added));
    check('add: insert payload has no id/user_id/archived_at', !('id' in insertCall) && !('user_id' in insertCall) && !('archived_at' in insertCall), Object.keys(insertCall).join(','));
    check('add: appears in inactive, sorted', (await page.$$eval('section.group:last-of-type .row-name', (n) => n.map((x) => x.textContent))).join('|') === '<img src=x onerror=alert(1)>|A Service With A Really Quite Long Name Plus|Google One|Paramount+');
    check('add: toast', (await page.textContent('#toast')) === 'added Paramount+');
    check('count now 6', (await page.textContent('.subs-title small')) === '6');

    // RLS-blocked update surfaces an error, modal stays open
    await page.evaluate(() => { window.__fake.blockWrites = true; });
    await page.click('.service-row:has-text("Spotify")');
    await page.click('[data-action="edit"]');
    await page.fill('#f-notes', 'hello');
    await page.click('#svc-save');
    await page.waitForFunction(() => document.querySelector('#svc-error').textContent);
    check('blocked update: error shown, modal open', (await page.textContent('#svc-error')) === "couldn't save the service: not found, or not yours" && await page.isVisible('#svc-modal.open'));

    // escape closes; backdrop drag doesn't
    await page.keyboard.press('Escape');
    check('escape closes the form', !(await page.isVisible('#svc-modal.open')));
    check('seeded: no page errors or alerts', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // 3. desktop width
  {
    const { ctx, page } = await open(browser, { seed: SEED, viewport: { width: 1280, height: 800 } });
    await page.screenshot({ path: `${h.SHOTS}/dashboard-1280.png`, fullPage: true });
    await page.click('[data-action="add"]');
    await page.screenshot({ path: `${h.SHOTS}/add-modal-1280.png` });
    check('desktop: no sideways scroll', await noSideScroll(page));
    await ctx.close();
  }

  // 4. load failure surfaces with retry
  {
    const broken = FAKE.replace("if (op === 'select') return { data: rows.map((r) => ({ ...r })), error: null };", "if (op === 'select') return { data: null, error: { code: '42501', message: 'permission denied' } };");
    const ctx = await h.newContext(browser, { viewport: { width: 375, height: 700 } }, broken);
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector('.load-error');
    check('load failure: message + retry button', (await page.textContent('.load-error p')).startsWith("couldn't load services: permission denied") && await page.isVisible('[data-action="reload"]'));
    await ctx.close();
  }

  await browser.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
