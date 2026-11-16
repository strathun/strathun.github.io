# Subscription Rotation Tracker — Spec

Status: Draft v1.1 · Owner: Hunter · Route: `strathun.github.io/subs/`

**Changelog**
- v1.1 (2026-11-16):
  - Added a `charges` ledger and spend metrics with annual amortization.
  - Added a year view (which services were active in which month).
  - Prices are shown for every service, including inactive ones.
  - Added archive/delete for services.
  - Keeper renewals are now recorded automatically (this replaces the "Renewed" button).
  - Dropped billing channel (everything is billed direct).
  - Added Phase 2: tiers and bundles.
  - Resolved all open questions.
- v1.0 (2026-11-16): first draft.

---

## 1. Problem

I want to keep only the subscriptions I'm actively using. Streaming services should rotate in and out: subscribe for a month, cancel the same day, let the paid month run out. Today the friction is (a) remembering what's active, (b) finding each service's cancel page, (c) forgetting to cancel, and (d) not knowing what I actually spend. This app is the single source of truth for what's active, when access ends, where to cancel or resubscribe, and what it all costs.

## 2. Goals (v1)

1. **Track services.** List every service I care about, active or not. Each shows its role (keeper or rotator), current price, billing interval, and a one-click link to its manage/cancel page. Services can be added, edited, archived and deleted.
2. **Record periods.** Subscribe/cancel events are stored as **periods**, so the app knows what's active and when access ends.
3. **Record charges.** Every payment is a **charge**. Keeper renewals are recorded automatically.
4. **Show spend.** Three numbers:
   - this month's spend;
   - this year so far, plus a projected full year;
   - average monthly spend this year.

   Annual charges are spread over the months they cover.
5. **Year view.** A grid of which services were active in which month of the year, and what each cost per month.
6. **Make "cancel on day one" hard to skip.** Any rotator that is subscribed but not cancelled shows a persistent **Cancel now** alert.
7. **Warn before keeper renewals**, respecting each service's cancel lead time.
8. **Watchlist.** Each service gets a list of things to come back for ("come back for: Severance S3"), and the app suggests what to rotate in next.

## 3. Non-goals (v1)

- No automated cancelling or resubscribing (no scripting of third-party sites, no stored passwords).
- No bank linking or statement import.
- No billing-channel tracking (App Store, Google Play, etc.). Everything is assumed billed direct.
- No server-side notifications (email/push). Reminders are calendar (.ics) downloads.
- Single user only.
- Tiers and bundle suggestions wait for Phase 2 (§13).

## 4. Context and constraints

- Lives on the existing hub at `/subs/`: **vanilla JS + Supabase**, existing dark minimal design system. Follow the structure, auth, and styling patterns of the existing travel planner app. No new frameworks or build step.
- GitHub Pages is public, so **all data protection comes from Supabase Row Level Security.** The anon key in client code is fine only because every table has RLS. Never put the service-role key in the repo.
- Must work at phone width.

## 5. Core concepts

- **Keeper**: kept year-round. The app watches its renewal date and records renewals automatically.
- **Rotator**: subscribed only when needed. Expected state is "cancelled, access running out" or "inactive".
- **Period**: one stretch of being subscribed: started → (cancelled) → access ends.
- **Charge**: one payment, with its date and amount. Spend is computed only from charges, never from list prices, so price changes don't rewrite history.
- **Cancel lead days**: how many days before renewal you must cancel to avoid the next charge.

## 6. Data model (Supabase / Postgres)

All tables have `user_id uuid not null default auth.uid() references auth.users`, and RLS policies for select/insert/update/delete with `user_id = auth.uid()`.

### `services`
| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| name | text not null | |
| category | text | `video`, `music`, `gaming`, `storage`, `shopping`, `ai`, `other` |
| role | text not null | `keeper` or `rotator` |
| billing_interval | text not null default `monthly` | `weekly`, `monthly`, `quarterly`, `annual` |
| price_cents | int null | current price of *my* plan; shown even when inactive. Null = unknown, flagged |
| price_checked_on | date null | when the price was last confirmed; flagged after 180 days |
| manage_url | text null | page where the cancel/resubscribe control lives |
| manage_path | text null | plain-text path when there's no web page (e.g. iCloud on device) |
| help_url | text null | official how-to-cancel article |
| url_verified | bool default false | false = deep link is a best guess; UI shows "verify link" |
| cancel_lead_days | int default 1 | |
| notes | text null | |
| archived_at | timestamptz null | soft delete (§8.4) |
| created_at | timestamptz default now() | |

### `periods`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| service_id | uuid fk → services, on delete cascade | |
| started_on | date not null | |
| renews_on | date null | next charge date while not cancelled |
| cancelled_on | date null | date auto-renew was turned off |
| access_ends_on | date null | last day of access after cancelling |

Constraint: at most one *uncancelled* period per service. Use a partial unique index on `(service_id) where cancelled_on is null`.

### `charges`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| service_id | uuid fk → services, on delete cascade | |
| period_id | uuid fk → periods, on delete set null | |
| charged_on | date not null | |
| amount_cents | int null | null = unknown, flagged and excluded from totals |
| interval | text not null | snapshot of the billing interval this charge paid for |
| source | text not null default `manual` | `manual` or `auto` (§7.3) |

Unique index on `(period_id, charged_on)`. This makes automatic renewal recording idempotent, even with the app open in two tabs.

### `watchlist_items`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| service_id | uuid fk → services, on delete cascade | |
| title | text not null | |
| available_from | date null | |
| done_at | timestamptz null | |
| sort_order | int default 0 | |

## 7. Logic (pure functions, unit-tested)

Put all of this in modules with no DOM or Supabase calls (e.g. `logic/status.js`, `logic/spend.js`), tested with `node --test`. The UI only renders what these return.

**Dates** are local calendar dates (`YYYY-MM-DD` from local date parts, never `toISOString()`). Month math clamps to month end (Jan 31 + 1 month = Feb 28/29). Money is integer cents. Round only for display.

### 7.1 Status (per service, from its latest period, given `today`)
- `renewing`: latest period has `cancelled_on` null.
- `ending`: `cancelled_on` set and `access_ends_on >= today`. Show "Active until {date}".
- `inactive`: no periods, or `access_ends_on < today`.

### 7.2 Alerts
- **Cancel now**: `role = rotator` and status `renewing`.
- **Decide by {date}**: `role = keeper`, status `renewing`, and `renews_on - cancel_lead_days` is within 14 days.
- **Verify link**: `url_verified = false`.
- **Price unknown**: `price_cents` is null.
- **Check price**: `price_checked_on` is more than 180 days old.
- **Amount unknown**: any charge with null `amount_cents`.

### 7.3 Subscribing, cancelling, automatic renewals
- **Mark subscribed** (date defaults to today and is editable, so the same flow backfills history):
  - creates a period with `started_on = date` and `renews_on = date + 1 interval`;
  - creates a charge on `date` for `price_cents`.
- **Mark cancelled**: sets `cancelled_on` (default today). Default `access_ends_on = renews_on - 1 day`, editable, because the service's confirmation screen states the real date.
- **Automatic renewal catch-up** runs on app load, for each period with `cancelled_on` null and `renews_on <= today`:
  1. insert a charge (`charged_on = renews_on`, `amount_cents = price_cents`, `source = auto`);
  2. advance `renews_on` one interval;
  3. repeat until `renews_on > today`.

  A forgotten rotator also gets charged here. That's the truth, and its Cancel-now alert stays up.

### 7.4 Amortization
Each charge is spread over **coverage months**, starting with the month of `charged_on`:

| interval | coverage months |
|---|---|
| weekly, monthly | 1 (the whole amount counts in the month it was charged) |
| quarterly | 3 |
| annual | 12 |

The amount is split evenly across those months in cents. Remainder cents go to the *latest* months, so the slices always sum exactly to the charge. For example, $100 becomes 833¢ × 8 months, then 834¢ × 4 months.

### 7.5 Spend metrics (for the selected year Y, current month M)
- **This month**: sum of all charge slices that fall in month M.
- **This year so far (amortized)**: sum of slices in Y, Jan through M.
- **Average monthly (this year)**: this year so far ÷ M (the current month counts, so January divides by 1).
- **Cash paid this year**: sum of `amount_cents` for charges with `charged_on` in Y. Shown as secondary text.
- **Projected full year**: this year so far + slices already committed for months after M (annual/quarterly charges already paid) + (12 − M) × run rate of services that are `renewing` and have no committed slice in those months. Label it "if nothing changes".

Worked example: a $100 annual charge on Jan 1, 2026:
- January: this month $8.33, average $8.33, so far $8.33, cash $100.
- June: average $8.33, so far $49.98.

A $120 annual charge on Aug 10, 2025 contributes $10 to each of Jan–Jul 2026. If it's still renewing, catch-up records the Aug 10, 2026 renewal, which covers Aug 2026–Jul 2027.

### 7.6 Year view
For year Y, there is one row per service that was active or had a slice in Y (including archived ones), and one column per month.
- A cell is **active** if any period's access window overlaps that month. The window runs from `started_on` to `access_ends_on`, or to today if still renewing.
- A cell shows the service's slice amount for that month, if any.
- Months after the current month show committed slices only, muted.
- A totals row equals "This month" for each month.

### 7.7 Next up
Among inactive rotators, pick the one with the most open watchlist items. Ties go to the earliest `available_from`.

## 8. Screens

1. **Dashboard**
   - Spend tiles: This month · Average monthly · This year so far / projected (with cash paid as secondary text).
   - Alerts.
   - Services grouped as Active (renewing), Active until… (ending), Inactive.
   - Every row shows the current price and interval, including inactive ones.
   - "Next up" card.
2. **Year view**: the §7.6 grid with a year switcher. On a phone it scrolls horizontally inside its own container, with the service-name column sticky. The page itself never scrolls sideways.
3. **Service detail**
   - Status, the **Open manage page** button, help link, price ("checked {date}"), notes.
   - Period history, charges (amounts editable, `auto` ones badged), watchlist.
   - Actions: **Mark subscribed**, **Mark cancelled**, **Add reminder (.ics)**, Edit, Archive.
4. **Add / edit / remove services**
   - **Add**: a form for all `services` fields.
   - **Archive** is the default way to remove a service. It hides the service from the dashboard but keeps its history, so past spend stays correct. Archived services are listed under a "Show archived" toggle and can be restored.
   - **Delete permanently** is only offered for archived services. It needs a typed confirmation and removes the service's periods, charges and watchlist.
5. **First run**: if there are zero services, show **Load starter list**, which inserts §11 once, then the §11 setup checklist.

## 9. Key flows

**Rotate in (rotator):**
1. Tap **Open manage page** and subscribe on the service's site.
2. Back in the app, tap **Mark subscribed** (records the charge).
3. The app immediately prompts "Cancel auto-renew now?" with the manage link.
4. Tap **Mark cancelled** and confirm `access_ends_on`.
5. The service shows "Active until {date}".

**Keeper renewal:** the Decide-by warning appears. If you do nothing, catch-up records the renewal charge on the renewal date. If the price changed, edit that charge and update `price_cents`. To drop the keeper, cancel via the manage link and **Mark cancelled**.

**Reminders:** **Add reminder (.ics)** downloads a one-day event:
- for rotators, on `access_ends_on`;
- for keepers, on `renews_on - cancel_lead_days`.

## 10. Acceptance criteria

**Security**
1. Signed out, or signed in as another user, no rows are readable or writable in any table. Test this with the anon key from the browser console.

**Setup and services**
2. **Load starter list** inserts the §11 services exactly once.
3. Archiving a service hides it from the dashboard. Year view and all spend numbers are unchanged. Restoring brings it back.
4. Delete is only available on archived services, requires typed confirmation, and removes its periods, charges and watchlist.
5. Inactive services show their current price. A price checked more than 180 days ago shows "Check price".

**Periods and charges**
6. **Mark subscribed** with a past date creates a period and one charge on that date. If the date is more than one interval ago, the next load's catch-up adds the missed renewals and doesn't duplicate them.
7. **Mark subscribed** is disabled while the service has an uncancelled period (the database constraint also enforces this).
8. **Mark cancelled** clears the Cancel-now alert and shows "Active until {date}". The day after `access_ends_on`, the service shows Inactive with no background job.
9. Catch-up is idempotent: loading the app twice, or in two tabs, never creates duplicate charges.

**Spend**
10. The §7.5 worked examples produce exactly those numbers in tests.
11. A $15 monthly charge on Nov 16 counts $15 in November. A $100 annual charge's 12 slices sum to exactly 10000 cents.
12. In year view, the totals row for the current month equals the "This month" tile.

**Alerts, reminders, layout**
13. Decide-by warnings appear 14 days ahead, using `cancel_lead_days`.
14. The `.ics` file imports into Google Calendar and Apple Calendar on the correct local date.
15. All logic functions have passing tests, including month-end clamping, the evening (UTC) date boundary, and amortization remainders.
16. Usable at 375px width. Only the year grid scrolls sideways, inside its own container.

## 11. Seed data and setup

Roles are proposals; change them in the app. `url_verified: true` means the link came from official help pages, several consistent sources, or me. `false` means the menu path is confirmed but the deep link is a best guess. Replace it with wherever the browser actually lands the first time.

Prices are deliberately left blank (except the two I know). Enter what my statements actually show, including tax, so spend matches reality.

```json
[
  { "name": "Spotify", "category": "music", "role": "keeper", "billing_interval": "monthly",
    "manage_url": "https://www.spotify.com/account/subscription/", "url_verified": false,
    "help_url": "https://support.spotify.com/article/cancel-premium/", "cancel_lead_days": 1,
    "notes": "Account page → Manage your plan → Cancel subscription. Premium runs to next billing date. Cancelling a $0 trial ends it immediately." },

  { "name": "Uzzu", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://uzzu.tv/billing/member", "url_verified": true,
    "help_url": null, "cancel_lead_days": 1,
    "notes": "Live sports streaming. Rotate with the seasons." },

  { "name": "Nintendo Switch Online", "category": "gaming", "role": "keeper", "billing_interval": "annual",
    "price_cents": 2100,
    "manage_url": "https://accounts.nintendo.com/portal", "url_verified": true,
    "help_url": "https://en-americas-support.nintendo.com/app/answers/detail/a_id/41196", "cancel_lead_days": 2,
    "notes": "Shop Menu → Nintendo Switch Online → Turn off automatic renewal. Must be off ≥48h before renewal. Can't be re-enabled once off; every new purchase turns auto-renew back on." },

  { "name": "Claude", "category": "ai", "role": "keeper", "billing_interval": "monthly",
    "manage_url": "https://claude.ai/settings/billing", "url_verified": false,
    "help_url": "https://support.claude.com/en/articles/8325617", "cancel_lead_days": 1,
    "notes": "Settings → Billing → Cancel. Cancel ≥24h before the billing date." },

  { "name": "Google One", "category": "storage", "role": "keeper", "billing_interval": "annual",
    "price_cents": 5000,
    "manage_url": "https://one.google.com/settings", "url_verified": true,
    "help_url": "https://support.google.com/googleone/answer/9056360", "cancel_lead_days": 1,
    "notes": "Gmail/Drive/Photos storage. Settings → Cancel membership. Storage lasts to end of billing cycle; dropping below usage affects Gmail." },

  { "name": "Paramount+", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://www.paramountplus.com/account/", "url_verified": true,
    "help_url": null, "cancel_lead_days": 1,
    "notes": "Account → Subscription & Billing → Cancel Subscription." },

  { "name": "Amazon Prime", "category": "shopping", "role": "keeper", "billing_interval": "annual",
    "manage_url": "https://www.amazon.com/mc", "url_verified": true,
    "help_url": "https://www.aboutamazon.com/news/retail/how-to-cancel-amazon-prime-membership", "cancel_lead_days": 1,
    "notes": "Manage Membership → End Membership; skip pause/switch offers. Final screen says whether benefits end now (refund) or at renewal." },

  { "name": "iCloud+", "category": "storage", "role": "keeper", "billing_interval": "monthly",
    "manage_url": null, "manage_path": "iPhone Settings → [name] → iCloud → Manage Storage → Change Storage Plan → Downgrade Options",
    "url_verified": true, "help_url": "https://support.apple.com/HT207594", "cancel_lead_days": 1,
    "notes": "Cancel = choose the free 5 GB plan. Takes effect at end of billing period." },

  { "name": "Netflix", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://www.netflix.com/cancelplan", "url_verified": true,
    "help_url": "https://help.netflix.com/en/node/407", "cancel_lead_days": 1,
    "notes": "Cancel → Finish Cancellation. Skip 'Pause for 1 Month': a pause auto-resumes and charges, so it defeats rotation." },

  { "name": "PlayStation Plus", "category": "gaming", "role": "keeper", "billing_interval": "monthly",
    "manage_url": "https://www.playstation.com/en-us/support/store/cancel-ps-store-subscription/", "url_verified": false,
    "help_url": "https://www.playstation.com/en-us/support/store/cancel-ps-store-subscription/", "cancel_lead_days": 1,
    "notes": "For online play with friends. Set the real interval (1, 3 or 12 months) at setup. Account Management → Subscription → Turn Off Auto-Renew. Every new purchase turns auto-renew back on." },

  { "name": "Crunchyroll", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://www.crunchyroll.com/account/membership", "url_verified": false,
    "help_url": null, "cancel_lead_days": 1,
    "notes": "My Account → Membership Plan → Cancel Membership (web only, not in the app)." },

  { "name": "Apple TV", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://tv.apple.com", "url_verified": true,
    "help_url": "https://support.apple.com/118398", "cancel_lead_days": 1,
    "notes": "Account icon → Settings → Subscriptions → Manage → Cancel Subscription. Or iPhone Settings → [name] → Subscriptions." },

  { "name": "Disney+", "category": "video", "role": "rotator", "billing_interval": "monthly",
    "manage_url": "https://www.disneyplus.com/account", "url_verified": true,
    "help_url": null, "cancel_lead_days": 1,
    "notes": "Account → your plan → Cancel Subscription (not the Pause button above it)." }
]
```

**First-run setup checklist** (shown in the app after loading the starter list):

1. For each service, enter `price_cents` and confirm `billing_interval`. A statement is the best source.
2. For each currently active service, **Mark subscribed** on the date of its *most recent* charge:
   - Spotify, Uzzu, Nintendo, Claude, Google One, Paramount+, Amazon Prime, iCloud+, Netflix, PS Plus.
   - For annual keepers (Nintendo, Google One, Prime), that date may be in 2025. That's what makes their 2026 amortization correct.
3. For active rotators already cancelled (or cancel now), **Mark cancelled**.
4. Optional: backfill earlier 2026 rotations (past periods) so the year view and averages cover the whole year.

## 12. Build plan (small vertical slices, one commit each)

1. **Schema + RLS**: tables, indexes, policies. Verify acceptance criterion 1 before any UI.
2. **Logic + tests**: §7.1–7.7, test-first, including the §7.5 worked examples.
3. **Services**: list, add/edit, archive/restore/delete, starter list, setup checklist.
4. **Periods + charges**: subscribe/cancel, catch-up, alerts.
5. **Spend tiles + year view.**
6. **Watchlist + Next up.**
7. **.ics reminders + phone-width polish.**

## 13. Phase 2: tiers and bundles (after v1 ships)

Goal: for each service I'm tracking, see the current plan tiers. Get a suggestion when a bundle covers two or more of my services for less **in the months I actually use them together**.

- **`tiers`**: `service_id`, `name`, `price_cents`, `billing_interval`, `has_ads` bool, `notes`, `checked_on`. Shown on service detail. A "use this tier" action copies its price into `price_cents`.
- **`bundles`**: `name`, `price_cents`, `billing_interval`, `url`, `checked_on`. Plus **`bundle_services`** (`bundle_id`, `service_id`) for what each bundle includes.
- **Suggestion rule**: show a bundle when two or more of its services are in my (non-archived) list.
  - Display: bundle price vs. the sum of those services' current prices.
  - Rotation check: count the months in the last 12 where two or more of them were active at the same time (from §7.6). If that's under 6, flag "You rarely have these together. Rotating separately is probably cheaper."
- **Data source**: tier and bundle prices change constantly, so they're entered as data, not code. Refresh them roughly quarterly; `checked_on` older than 120 days is flagged.

## 14. Later

- "Should this be annual?" stat: months active in the last 12 per service. Recommend annual at about 10+ months.
- Statement CSV import to catch charges that aren't tracked and to backfill history.
- A saved Claude in Chrome prompt per service for the cancel/resubscribe clicks.
- Billing-channel tracking (App Store, Amazon Channels) if anything moves off direct billing.
