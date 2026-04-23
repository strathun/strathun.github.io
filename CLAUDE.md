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
└── CLAUDE.md            # This file
```

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

RLS is enabled — users can only read/write their own rows.

**When adding tables for new apps:** always enable RLS and add the four standard policies (select/insert/update/delete scoped to `auth.uid() = user_id`). Write the SQL in a comment block at the top of the app's `index.html` for reference.

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

**Deploy:** just `git push origin main` — GitHub Pages auto-deploys within ~60 seconds.
No build step, no CI needed.

---

## Conventions

- **File naming:** lowercase, hyphenated (`my-app/index.html`)
- **JS:** vanilla ES6+, no frameworks, no bundler. Keep it simple.
- **CSS:** page-specific styles go in a `<style>` block in the page's `<head>`. Shared styles only go in `assets/style.css` if they're used by 2+ pages.
- **No external JS libraries** unless there's a strong reason. If needed, load from `cdn.jsdelivr.net` or `cdnjs.cloudflare.com`.
- **Active session state** (e.g. a running timer) uses `localStorage` as a temporary store since it doesn't need to survive across devices. Persistent user data always goes to Supabase.
- **Error handling:** always surface errors to the user via a toast or inline message — never silently swallow them.
- **Git commits:** present tense, lowercase, descriptive (`add habit tracker`, `fix calendar day selection bug`)

---

## Current Apps

| App | Path | Supabase tables |
|-----|------|-----------------|
| Game Tracker | `/games/` | `game_sessions` |

---

## Known Limitations / Future Ideas

- No dark/light mode toggle (always dark)
- No push notifications / reminders
- Mobile nav on hub page could be improved for 10+ apps
- Consider a `_template/` folder with a starter boilerplate for new apps
