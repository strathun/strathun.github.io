# subs/dev — browser checks

Playwright scripts that drive the real subs pages against a **fake, in-memory Supabase**,
so UI behaviour can be checked without signing in or touching the real database.
They complement the unit tests in `subs/logic/` (rules) by covering the page (rendering,
dialogs, routing, error messages, phone-width layout).

Not part of the app and not run in CI (CI only runs `node --test`).

## Run

From the repo root:

```bash
node subs/dev/run.cjs
```

That starts a small local server, runs every `checks-*.cjs`, and exits 1 if anything fails.
A single file also runs on its own: `node subs/dev/checks-detail.cjs`.
Screenshots go to your temp folder under `subs-shots/` (or `SHOTS_DIR`).

Needs Playwright with Chromium. Claude Code cloud sessions already have it. Locally:

```bash
npm install --no-save playwright
```

```bash
npx playwright install chromium
```

## Files

| file | what |
|---|---|
| `fake-supabase.js` | stand-in for supabase-js: in-memory tables, seeding, `rpc()` copies of the migration functions, blocked writes, failed rpcs, slow responses |
| `harness.cjs` | static server, browser context with the fake and a **frozen clock** (2026-11-16), check/report helpers |
| `run.cjs` | runs every `checks-*.cjs` against one server |
| `checks-services.cjs` | dashboard list, add/edit form |
| `checks-detail.cjs` | detail view, archive, restore, delete |
| `checks-starter.cjs` | starter list, setup checklist |
| `checks-dialogs.cjs` | dialogs during slow saves, back button, malformed links |
| `checks-nav.cjs` | shared nav on every page at 375–1280px |
| `checks-history.cjs` | period history and charges on service detail |
| `checks-subscribe.cjs` | mark subscribed: amount, set-as-price, validation, failed transactions |
| `checks-cancel.cjs` | mark cancelled: the cancel-now prompt, defaults, backfills, a second tab |
| `checks-catchup.cjs` | renewal catch-up on load: what's charged, reloads, half-finished runs, failure banner |
| `checks-delete-period.cjs` | delete period: the confirmation, what's removed (acceptance 18), failures |
| `checks-charges.cjs` | edit charge: amount, date, set-as-price, partial failures and retries |
| `checks-alerts.cjs` | dashboard alerts: order, text, acting in place (acceptance 20), an older open period (acceptance 19) |
| `checks-spend.cjs` | dashboard spend tiles: hand-worked numbers, archiving changes nothing (acceptance 3), rounding, layout |
| `checks-yearview.cjs` | year view: grid cells and totals (acceptance 12), past and future years (21), `#/y/{year}` and its range (22), back button, phone scrolling (16) |
| `supabase-stub.sql` | roles, `auth.users` and `auth.uid()`: enough Supabase for plain Postgres |
| `sql-check.sh` | runs `schema.sql`, `migrations/*.sql` and `rls-test.sql` on a local Postgres |

## Writing a check

- Name it `checks-<area>.cjs`. Never `test-*.js` or `*.test.js`: `node --test` would run it.
- Seed data with dates around the frozen clock (2026-11-16, the same day as `subs/logic/fixtures.js`),
  so date text like "until dec 9" never changes as real time passes.
- The fake enforces only the unique service name. Anything the database guarantees
  (RLS, foreign keys, transactions) still needs `subs/rls-test.sql` (below) or a real-database check.

## SQL check (local Postgres)

`rls-test.sql` is written for the Supabase SQL editor, but it also runs on plain Postgres 15+
with `supabase-stub.sql` standing in for Supabase's roles and `auth` schema:

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres bash subs/dev/sql-check.sh
```

It recreates a `subs_rls_test` database, runs `schema.sql` and every migration twice (both promise
they're safe to re-run), then `rls-test.sql`, and fails unless the last row is `ALL RLS CHECKS PASSED`.
Use it before asking for a migration to be run on Supabase. It doesn't replace that real run: the stub
only imitates Supabase's grants and `auth.uid()`.
