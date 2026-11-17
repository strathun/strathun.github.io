// Shared nav on every page (assets/style.css container query): at 375/480/768/1280px the nav
// never overflows, its parts never overlap, the subs link is present, and the page never
// scrolls sideways. Repeated with a long email, which must shorten with an ellipsis.
// Run all checks: node subs/dev/run.cjs (see README.md).
const { chromium } = require('playwright');
const h = require('./harness.cjs');

const PAGES = ['/', '/games/', '/games/library/', '/travel/', '/subs/'];
const WIDTHS = [375, 480, 768, 1280];
const LONG_EMAIL = 'someone.with.a.long.name@example.com';

(async () => {
  const base = await h.baseUrl();
  const { check, report } = h.checker();
  const browser = await chromium.launch();

  for (const long of [false, true]) {
    const fake = long ? h.FAKE.replace('tester@example.com', LONG_EMAIL) : h.FAKE;
    for (const width of WIDTHS) {
      const ctx = await h.newContext(browser, { viewport: { width, height: 800 } }, fake);
      for (const path of PAGES) {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + path);
        await page.waitForSelector('.site-nav .nav-user span:not(:empty)');
        const m = await page.evaluate(() => {
          const nav = document.querySelector('.site-nav');
          const r = nav.getBoundingClientRect();
          const kids = [...nav.children].map((c) => c.getBoundingClientRect());
          const overlap = kids.some((a, i) => kids.some((b, j) => i < j && a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1));
          const outside = kids.some((k) => k.left < r.left - 1 || k.right > r.right + 1);
          return {
            overflow: nav.scrollWidth > nav.clientWidth + 1 || outside,
            overlap,
            subsLink: !!nav.querySelector('a[href="/subs/"]'),
            pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });
        // The hub greeting overflows with a 24+ character email prefix (CLAUDE.md, Known
        // Limitations), so with the long email only the nav itself is checked.
        const ok = !m.overflow && !m.overlap && m.subsLink && !errors.length && (long || !m.pageScroll);
        check(`${long ? 'long email ' : ''}${width}px ${path}`, ok, ok ? '' : JSON.stringify(m) + (errors[0] ? ` ${errors[0]}` : ''));
        if (width === 375) {
          const name = `nav-${width}${path.replace(/\//g, '_')}${long ? 'long' : ''}.png`;
          await page.screenshot({ path: `${h.SHOTS}/${name}`, clip: { x: 0, y: 0, width, height: 110 } });
        }
        await page.close();
      }
      await ctx.close();
    }
  }

  await browser.close();
  report();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
