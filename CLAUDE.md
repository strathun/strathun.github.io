# CLAUDE.md — strathun.github.io

This file is read automatically by Claude Code at the start of every session.
Update it as the project evolves.

---

## Project Overview

Personal hub site hosted on **GitHub Pages** (`https://strathun.github.io`).
A collection of personal tools and apps, all sharing a common auth layer and design system.
No build step — everything is vanilla HTML/CSS/JS. Deploy = git push.

**Backend:** Supabase (Postgres + auth)
- Project URL: `https://gfiigncjwtuslwqlyasr.supabase.co`
- Anon key is embedded in `assets/auth.js` (public key, safe to commit)
- Auth: email + password only

---

## Repo Structure

```
strathun.github.io/
├── index.html           # Hub homepage — lists all apps, shows aggregate stats
├── assets/
│   ├── style.css        # Shared design system (CSS variables, nav, auth gate, utilities)
│   └── auth.js          # Supabase client init + renderAuthGate() helper
├── games/
│   └── index.html       # Game time tracker
├── [future-app]/
│   └── index.html       # Each new app gets its own folder
├── subs/                # Subscription tracker (in progress)
│   ├── SPEC.md          # Behavior spec: source of truth for logic and acceptance criteria
│   ├── schema.sql       # Tables + RLS (rls-test.sql verifies it)
│   ├── package.json     # Marks subs/ as ES modules for node --test; not a build
│   ├── index.html       # Markup + styles; loads app.js as a module
│   ├── app.js           # Rendering, hash routes (#/ dashboard, #/s/{id} detail), events
│   ├── db.js            # Supabase calls; throws DbError so the page can show it
│   └── logic/           # Pure logic (SPEC §7, service form, starter list) + *.test.js, no DOM or Supabase
├── runs/                # Public share pages (see "Public pages" below)
│   ├── dead-horse/      # Dead Horse 50K training map: index.html + routes.json
│   └── tools/
│       └── parse_gpx.py # Garmin GPX folder → routes.json
└── CLAUDE.md            # This file
```

---

## Public pages

Some pages exist to be shared by link with people who don't have an account (e.g. a run map for a friend).
These are **not apps**: they live under a topic folder like `runs/`, have **no auth gate and no site nav**,
and are not listed in the hub's `.app-grid`. Everything else still applies: `/assets/style.css` variables
for page chrome, JetBrains Mono, vanilla JS, errors surfaced inline.

- Data-visualization colors (e.g. a route color ramp) may be hardcoded in JS — they encode data, not chrome.
- Map tiles must be **keyless** or use a key restricted to `strathun.github.io`. CARTO basemaps now watermark
  keyless requests ("API KEY REQUIRED"), so they're not used. Current pages use Esri (dark, satellite) and
  USGS (topo) tiles, with automatic fallback if a provider fails.
- Leaflet loads from jsdelivr with SRI `integrity` hashes.
- To add a run map: export GPX from Garmin Connect into a folder, run
  `python3 runs/tools/parse_gpx.py <folder> runs/<name>/routes.json`, copy `runs/dead-horse/index.html`
  and update its title/kicker text.

---

## Design System

**Color palette (CSS variables in assets/style.css):**
- `--bg` `#0d0d0f` — page background
- `--bg1` `#131316` — card / surface
- `--bg2` `#1a1a1e` — input / secondary surface
- `--bg3` `#222227` — tertiary surface
- `--border` `#2a2a30` — default border
- `--border2` `#38383f` — hover border
- `--text` `#e2e2dc` — primary text
- `--muted` `#5a5a65` — secondary / label text
- `--dim` `#3a3a42` — very muted (dividers, placeholders)
- `--accent` `#7c6dfa` — primary accent (purple)
- `--accent2` `#4ecfa8` — secondary accent (teal, used for positive values)
- `--warn` `#f0a040` — warning / streaks
- `--danger` `#e85555` — destructive actions

**Typography:**
- Primary font: `JetBrains Mono` (loaded from Google Fonts on every page)
- UI font: `DM Mono` (fallback)
- Both are monospace — this is intentional, IDE/terminal aesthetic

**Aesthetic:** Dark, minimal, monospace. Programmer IDE meets personal dashboard.
Avoid gradients, heavy shadows, or flashy effects. Precision and readability over decoration.

**Shared nav:** when the nav itself is under 700px wide, its links move to a second row and a long
email shortens with an ellipsis. This is a container query in `assets/style.css`, so it also covers pages with
a narrow body (games: 480px) on desktop. Don't add per-page nav overrides; check new nav links at 375px.

---

## Adding a New App

1. Create the folder and file: `mkdir myapp && touch myapp/index.html`
2. Use this boilerplate at the top (copy from `games/index.html`):
   - `<link rel="stylesheet" href="/assets/style.css">` 
   - `<script src="/assets/auth.js"></script>`
   - Include the shared `<nav class="site-nav">` with correct `.active` link
   - Call `window.renderAuthGate(async (user) => { ... })` to gate the app behind login
3. Add a new `<a href="/myapp/" class="app-card">` entry in `index.html` → `.app-grid`
4. Add the nav link to **both** `index.html` and any existing app pages' `site-nav`
5. If the app needs database tables, write the SQL migration and note it here

**Every page must:**
- Include the shared nav with correct active link highlighted
- Gate all content behind `renderAuthGate()` — nothing renders before auth
- Use CSS variables exclusively for colors (never hardcode hex values in page styles)
- Load JetBrains Mono from Google Fonts

---

## Supabase Schema

### `games`
| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, auto |
| user_id | uuid | references auth.users, cascade delete |
| game | text | game title |
| pick_up_here | text | sticky note for where user left off |
| created_at | timestamptz | auto |
| updated_at | timestamptz | updated on save |

Unique constraint on `(user_id, game)`. Upserted on conflict.

### `game_todos`
| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, auto |
| user_id | uuid | references auth.users, cascade delete |
| game | text | game title |
| text | text | todo item text |
| status | text | `todo`, `in_progress`, or `done` (check constraint) |
| created_at | timestamptz | auto |

### `game_sessions`
| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, auto |
| user_id | uuid | references auth.users, cascade delete |
| game | text | game title |
| platform | text | "PC", "PS", or "Switch" |
| start_time | timestamptz | |
| end_time | timestamptz | |
| duration_ms | bigint | end - start in milliseconds |
| note | text | optional session note |
| manual | boolean | true if manually entered |
| created_at | timestamptz | auto |

### `travel_trips`
| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, auto |
| user_id | uuid | references auth.users, cascade delete |
| destination | text | trip destination |
| notes | text | freeform notes |
| start_date | date | inclusive |
| end_date | date | inclusive |
| status | text | `tentative` or `confirmed` (check constraint) |
| excluded_dates | jsonb | default `'[]'`; array of `'YYYY-MM-DD'` weekday strings excluded from PTO |
| created_at | timestamptz | auto |

RLS is enabled — users can only read/write their own rows.

### Subscription tracker (`subs/`)
Tables `services`, `periods`, `charges`, `watchlist_items`. Full definitions in `subs/schema.sql`
(source of truth) and `subs/SPEC.md` §6. Verify RLS with `subs/rls-test.sql` (runs in a rolled-back
transaction; last row must read `ALL RLS CHECKS PASSED`).
- `user_id` defaults to `auth.uid()`, so clients never send it.
- Child tables use composite FKs on `(service_id, user_id)` so a user can't attach rows to another user's service.
- `schema.sql` uses `create ... if not exists`, so re-running it won't alter an existing table. Later schema
  changes go in a new `alter table` migration (e.g. `subs/migrations/002-*.sql`).

**When adding tables for new apps:** always enable RLS and add the four standard policies (select/insert/update/delete scoped to `auth.uid() = user_id`). Write the SQL in a comment block at the top of the app's `index.html`, or for larger schemas in `<app>/schema.sql`. Use `(select auth.uid())` in policies, add `to authenticated`, and give updates a `with check`.

---

## Auth Pattern

`assets/auth.js` exposes three globals:

- `window.sb` — the Supabase client (available after `sb-ready` event fires)
- `window.getUser()` — async, returns current user or null
- `window.signOut()` — signs out and redirects to `/`
- `window.renderAuthGate(onSuccess)` — renders login/signup UI into `#auth-gate`, calls `onSuccess(user)` when authenticated

Every app page has:
```html
<div id="auth-gate" class="hidden"></div>
<div id="app" class="hidden">
  <!-- app content here -->
</div>
```

`renderAuthGate` handles showing/hiding these divs. Never show app content outside this callback.

---

## Local Development

```bash
# Start local server (pick one)
python3 -m http.server 8080
npx serve .

# Then open http://localhost:8080
```

Supabase works on localhost — you're hitting the real database.
`http://localhost:8080` should be added to Supabase → Authentication → URL Configuration → Redirect URLs.

**Tests:** apps with a `logic/` folder have unit tests (Node 22+, no install):

```bash
cd subs && node --test
```

`.github/workflows/subs-tests.yml` runs them on any push or PR touching `subs/`, in two timezones.

**Deploy:** just `git push origin master` — GitHub Pages auto-deploys within ~60 seconds.
No build step. CI only runs tests; it doesn't deploy.

---

## Conventions

- **File naming:** lowercase, hyphenated (`my-app/index.html`)
- **JS:** vanilla ES6+, no frameworks, no bundler. Keep it simple.
- **CSS:** page-specific styles go in a `<style>` block in the page's `<head>`. Shared styles only go in `assets/style.css` if they're used by 2+ pages.
- **No external JS libraries** unless there's a strong reason. If needed, load from `cdn.jsdelivr.net` or `cdnjs.cloudflare.com`.
- **Active session state** (e.g. a running timer) uses `localStorage` as a temporary store since it doesn't need to survive across devices. Persistent user data always goes to Supabase.
- **Error handling:** always surface errors to the user via a toast or inline message — never silently swallow them.
- **Supabase writes:** an update or delete that RLS blocks (or whose id is gone) returns no error and zero rows.
  Chain `.select()` and treat zero rows as a failure, as `subs/db.js` does.
- **Module pages** (`<script type="module">`, e.g. `subs/app.js`): their functions aren't globals, so use
  `data-action` attributes and one delegated click listener instead of `onclick="…"`. Modules don't load from
  `file://`, so use the local server.
- **Testable logic:** when an app has real rules (dates, money, state), put them in `<app>/logic/` as ES modules
  that take plain rows and `today` as arguments, with a `*.test.js` beside each. Pages load them with
  `<script type="module">`. Logic never touches the DOM or Supabase and never calls `toISOString()`
  (`subs/logic/guard.test.js` enforces this). Test helpers must not be named `test-*.js`, or `node --test` runs them.
- **Git commits:** present tense, lowercase, descriptive (`add habit tracker`, `fix calendar day selection bug`)

---

## Current Apps

| App | Path | Supabase tables |
|-----|------|-----------------|
| Game Tracker | `/games/` | `game_sessions` |
| Game Library | `/games/library/` | `games`, `game_todos` |
| Travel Planner | `/travel/` | `travel_trips` |
| Subscriptions (in progress) | `/subs/` | `services`, `periods`, `charges`, `watchlist_items` |

---

## Travel Planner (travel.html)
- Year-view calendar for planning trips across the full year
- Auth via /assets/auth.js, Supabase via window.sb (same as game tracker)
- Trips stored in travel_trips table (uuid, user_id, destination, notes, start_date, end_date, status)
- Status is either tentative (muted/dashed style) or confirmed (solid/vivid)
- Trips added via "Add Trip" modal with date pickers — no drag-to-select
- Clicking an existing trip opens edit/delete modal
- Mobile-first layout, 3×4 or 4×3 month grid
- PTO counter: counts weekdays (M-F) within trip ranges; weekends excluded, holidays counted (no holiday list)
- Two totals scoped to the viewed year: "committed" (confirmed) and "potential" (tentative), shown as a badge near year nav
- Per-day PTO toggle: edit modal lists each weekday in the trip with a checkbox (default checked = counts); unchecking excludes that day. Excluded dates stored in travel_trips.excluded_dates (jsonb array of 'YYYY-MM-DD')
- Counted PTO days show a small dot under the date number on the grid; excluded weekdays and weekends show no dot
- Counts use unique weekday dates to avoid double-counting overlaps; recompute on any trip change, day toggle, or year switch

---

## Known Limitations / Future Ideas

- No dark/light mode toggle (always dark)
- No push notifications / reminders
- With many more apps, the nav's link row scrolls sideways inside the nav on phones; a menu may be better
- Hub greeting (`#display-name`) doesn't wrap, so an email prefix of 24+ characters overflows at 375px
- Consider a `_template/` folder with a starter boilerplate for new apps
