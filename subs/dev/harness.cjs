// Shared setup for the subs browser checks (see README.md).
// Not part of the app: GitHub Pages serves this folder, but no page loads it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/** Repo root: the folder the site is served from. */
const ROOT = path.resolve(__dirname, '..', '..');

/** The fake supabase-js, served in place of the CDN script. */
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');

/**
 * Every check runs with the browser clock frozen at this local time, so date
 * text ("until dec 9", "check price") can't drift as real time passes.
 * Same day as subs/logic/fixtures.js TODAY.
 */
const FROZEN_NOW = '2026-11-16T12:00:00';

/** Screenshots go here; set SHOTS_DIR to choose. */
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'subs-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

/** A minimal static server for the repo root. Resolves to { url, close }. */
function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.unref(); // let a standalone check exit when it's done
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Site origin: BASE_URL when run.cjs started a server, otherwise a server of our own. */
async function baseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return (await startServer()).url;
}

/**
 * A browser context wired to the fake Supabase, with Google Fonts blocked
 * (no network needed) and the clock frozen at FROZEN_NOW.
 */
async function newContext(browser, options = {}, fake = FAKE) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, ...options });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ contentType: 'application/javascript', body: fake }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  return ctx;
}

/** check(name, ok, extra) collector; report() prints and sets the exit code. */
function checker() {
  const results = [];
  return {
    check: (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`),
    report() {
      console.log(results.join('\n'));
      const failed = results.some((r) => r.startsWith('FAIL'));
      console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
      if (failed) process.exitCode = 1;
    },
  };
}

module.exports = { ROOT, FAKE, FROZEN_NOW, SHOTS, startServer, baseUrl, newContext, checker };
