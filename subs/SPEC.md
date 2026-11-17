# Subscription Rotation Tracker — Spec

Status: Draft v1.6 · Owner: Hunter · Route: `strathun.github.io/subs/`

**Changelog**
- v1.6 (2026-11-17): rules settled while building step 4's data entry.
  - Mark subscribed refuses an archived service, a billing interval that changed since the page loaded, and a date so far back that catch-up would record over 1000 renewals (§7.3).
  - A $0 charge offers "Also set as current price" unticked, so a free trial doesn't become the price (§7.3).
  - Mark cancelled on a backfill whose renewal date has passed defaults to the start date, and refuses a date on or after that renewal (§7.3).
  - The cancel prompt also follows Mark subscribed for a backfill with a renewal pending, for keepers too (§9).
  - Editing a charge with "Also set as current price" saves the price first, then the charge (§8.3).
- v1.5 (2026-11-17): settled the subscribe/cancel gaps before building step 4.
  - Mark subscribed asks for the amount charged and can save it as the service's price, so prices and dates are entered together (§7.3).
  - Mark subscribed and Delete period each run in one database transaction (§6, §7.3, §8.3).
  - Periods can be deleted with their charges, and charges edited, so backfill mistakes are fixed in the app (§8.3).
  - Editing a charge's amount can also update the current price (§8.3, §9).
  - Setup checklist: confirm the billing interval before marking a service subscribed (§11).
- v1.4 (2026-11-17): settled the services-screen gaps before building step 3.
  - Archive is disabled while a service is renewing, so its charges can't continue unseen (§8.4).
  - Changing a price fills in `price_checked_on` with today unless you set the date (§8.4).
  - Service detail has its own URL, so the phone back button works (§8.3).
  - Dashboard rows show service-level alerts as badges (§8.1).
  - Setup checklist shows pricing progress, and can be dismissed and reopened (§11).
- v1.3 (2026-11-16): settled the §7 edge cases before writing the logic tests.
  - Renewals land on the start day, clamped to month end, so month-end starts don't drift (§7.3).
  - Projection adds run rate month by month, only where nothing is already committed (§7.5).
  - Defined month M for past and future years (§7).
  - Decide-by stays up after its date until the renewal is recorded. Check price also covers prices that were never checked (§7.2).
  - Blank access end, archived services, and next-up tie-breaks (§7.1, §7.2, §7.5, §7.7).
- v1.2 (2026-11-16):
  - Renamed `charges.interval` to `billing_interval` (`interval` is a Postgres type keyword).
  - Child tables use composite foreign keys on `(id, user_id)`, so rows can't be attached to another user's service or period.
  - Service names are unique per user (case-insensitive), so the starter list can't load twice.
  - Schema lives in `subs/schema.sql`; RLS acceptance test in `subs/rls-test.sql`.
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

Tenant safety: an RLS policy only checks the row being written, so child tables (`periods`, `charges`, `watchlist_items`) reference their parent with a composite FK on `(service_id, user_id)` → `services(id, user_id)`. `charges` references `periods(id, service_id, user_id)` with `on delete set null (period_id)`. A charge's period must then belong to the same service and user. Source of truth: `subs/schema.sql`.

Multi-row writes that must succeed or fail together run as Postgres functions in one transaction: Mark subscribed (§7.3) and Delete period (§8.3). They are `security invoker`, so they run as the signed-in user and RLS still applies. They live in `subs/migrations/002-*.sql`, and `subs/rls-test.sql` covers them.

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
| billing_interval | text not null | snapshot of the billing interval this charge paid for |
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

All of this lives in `subs/logic/`, one module per subsection (`dates.js`, `status.js`, `alerts.js`, `periods.js`, `amortize.js`, `spend.js`, `yearview.js`, `nextup.js`). The modules make no DOM or Supabase calls, take `today` as an argument, and read rows exactly as Supabase returns them. Run the tests with `cd subs && node --test`. The UI only renders what these return.

**Dates** are local calendar dates (`YYYY-MM-DD` from local date parts, never `toISOString()`). Month math clamps to month end (Jan 31 + 1 month = Feb 28/29). Money is integer cents. Round only for display.

**Month M** for a selected year Y is today's month when Y is the current year, 12 for a past year, and 0 for a future year.

### 7.1 Status (per service, from its latest period, given `today`)
The latest period is the one with the latest `started_on`.
- `renewing`: latest period has `cancelled_on` null.
- `ending`: `cancelled_on` set and access end `>= today`. Show "Active until {date}".
- `inactive`: no periods, or access end `< today`.

Access end is `access_ends_on`, or `renews_on - 1 day` if it was left blank.

### 7.2 Alerts
Archived services show no alerts.
- **Cancel now**: `role = rotator` and status `renewing`.
- **Decide by {date}**: `role = keeper`, status `renewing`, and the decide-by date (`renews_on - cancel_lead_days`) is 14 days away or less. It stays up after that date passes, until the renewal is recorded.
- **Verify link**: `url_verified = false`.
- **Price unknown**: `price_cents` is null.
- **Check price**: `price_cents` is set and `price_checked_on` is blank or more than 180 days old.
- **Amount unknown**: any charge with null `amount_cents`.

### 7.3 Subscribing, cancelling, automatic renewals
- **Mark subscribed** (date defaults to today and is editable, so the same flow backfills history; it can't be in the future, or so far back that catch-up would record more than 1000 renewals):
  - asks for the **amount charged**, prefilled from `price_cents`. Blank records an unknown amount;
  - creates a period with `started_on = date` and `renews_on = date + 1 interval`;
  - creates a charge on `date` for that amount;
  - **Also set as current price** (checkbox, shown when an amount is entered and it differs from `price_cents` or the price is unknown; ticked by default when the price is unknown, except for $0, since a free trial is rarely the next price): sets `price_cents` to the amount and `price_checked_on` to `date`, so catch-up renewals charge the right amount;
  - writes the period, the charge and any price change in one transaction (§6), so a dropped connection can't leave a period without its charge;
  - is refused for an archived service (restore it first: an archived service shows no alerts, so it must not start renewing), and when the service's billing interval changed since the page loaded (reload, so `renews_on` uses the right interval).
- **Mark cancelled**: sets `cancelled_on` (default today). Default `access_ends_on = renews_on - 1 day`, editable, because the service's confirmation screen states the real date.
  - `cancelled_on` can't be in the future or before `started_on`. `access_ends_on` can't be before `cancelled_on` (it can be the same day, e.g. a refund that ends access at once).
  - **Backfill with a renewal pending** (`renews_on <= today`, so catch-up hasn't run yet): the default is `started_on` (cancel on day one), and a date on or after `renews_on` is refused, because that renewal's charge would never be recorded. To record a cancellation after it, reload first so catch-up records the renewal.
- **Automatic renewal catch-up** runs on app load, for each period with `cancelled_on` null and `renews_on <= today`:
  1. insert a charge (`charged_on = renews_on`, `amount_cents = price_cents`, `source = auto`);
  2. advance `renews_on` one interval;
  3. repeat until `renews_on > today`.

  A forgotten rotator also gets charged here. That's the truth, and its Cancel-now alert stays up. Archived services are caught up too: an open period still bills.
- **Renewal day**: monthly, quarterly and annual renewals land on the day of `started_on`, clamped to month end. A Jan 31 start renews Feb 28, Mar 31, Apr 30 (not Feb 28, Mar 28, Apr 28). If `renews_on` was edited to a different day, that day becomes the renewal day. Weekly renewals add 7 days.

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
- **Projected full year**: this year so far + slices already committed for months after M (annual/quarterly charges already paid) + run rate for the rest. For each month after M, add the run rate of every `renewing` service with no committed slice in that month. Label it "if nothing changes".
  - Run rate is the monthly equivalent of `price_cents`: weekly × 52/12, monthly × 1, quarterly ÷ 3, annual ÷ 12. An unknown price counts as 0 (it already has a Price unknown alert).
  - This equals (12 − M) × run rate when nothing is prepaid. It differs when prepaid coverage ends mid-year.
- For a future year (M = 0), so far and average are blank.
- Archived services count everywhere in this section.

Worked example: a $100 annual charge on Jan 1, 2026:
- January: this month $8.33, average $8.33, so far $8.33, cash $100.
- June: average $8.33, so far $49.98.

A $120 annual charge on Aug 10, 2025 contributes $10 to each of Jan–Jul 2026. If it's still renewing, catch-up records the Aug 10, 2026 renewal, which covers Aug 2026–Jul 2027.

Projection examples (derived from the rules above):
- January 2026, the $100 service still renewing: $100.00 ($8.33 so far + $91.67 committed for Feb–Dec).
- June 2026, the $120 service still renewing: $120.00 ($60 so far + $10 committed for July + 5 × $10 run rate for Aug–Dec).

### 7.6 Year view
For year Y, there is one row per service that was active or had a slice in Y (including archived ones), and one column per month.
- A cell is **active** if any period's access window overlaps that month. The window runs from `started_on` to the access end (§7.1), or to today if still renewing.
- A cell shows the service's slice amount for that month, if any.
- Months after M are never active. They show committed slices only, muted.
- A totals row equals "This month" for each month.

### 7.7 Next up
Among inactive, non-archived rotators with at least one open watchlist item, pick the one with the most open items. Ties go to the earliest `available_from` among each service's open items. A blank `available_from` means available now and comes first. Remaining ties go by name.

## 8. Screens

1. **Dashboard**
   - Spend tiles: This month · Average monthly · This year so far / projected (with cash paid as secondary text).
   - Alerts.
   - Services grouped as Active (renewing), Active until… (ending), Inactive.
   - Every row shows the current price and interval, including inactive ones.
   - Every row shows its service-level alerts (Verify link, Price unknown, Check price) as badges. Cancel now, Decide by and Amount unknown appear in Alerts.
   - "Next up" card.
2. **Year view**: the §7.6 grid with a year switcher. On a phone it scrolls horizontally inside its own container, with the service-name column sticky. The page itself never scrolls sideways.
3. **Service detail** (its own URL, `#/s/{id}`, so the browser back button returns to the dashboard)
   - Status, the **Open manage page** button, help link, price ("checked {date}"), notes.
   - Period history. **Delete period** removes the period and its charges in one transaction (§6), after a confirmation that lists the charges it removes. It's how a backfill mistake is fixed: to change a start date, delete the period and mark subscribed again.
   - Charges, with `auto` ones badged. Amount and date are editable. Changing an amount offers **Also set as current price** (sets `price_cents`, and `price_checked_on` to the charge date), offered and ticked by the same rule as Mark subscribed. Two charges in one period can't share a date.
     - The price and the charge are two writes, not one transaction. The price is saved first: if the charge then fails, the error says the price was saved, and a retry only resends the charge. A new price with an old charge amount meanwhile is harmless, since the price only affects later renewals.
   - Watchlist.
   - Actions: **Mark subscribed**, **Mark cancelled**, **Add reminder (.ics)**, Edit, Archive.
4. **Add / edit / remove services**
   - **Add / Edit**: a form for all `services` fields.
     - Prices are typed in dollars (`12.99`) and stored as exact integer cents.
     - Changing the price fills in `price_checked_on` with today, unless you set that date yourself.
     - Names are unique (case-insensitive), archived services included. If the match is archived, the form says to restore it instead.
   - **Archive** is the default way to remove a service. It hides the service from the dashboard but keeps its history, so past spend stays correct. Archived services are listed under a "Show archived" toggle and can be restored.
     - Archive is disabled while the service is `renewing`. Mark it cancelled first. An archived service shows no alerts (§7.2), so a renewing one would keep charging unseen.
   - **Delete permanently** is only offered for archived services. It needs a typed confirmation and removes the service's periods, charges and watchlist.
5. **First run**: if there are zero services, show **Load starter list**, which inserts §11 once, then the §11 setup checklist.

## 9. Key flows

**Rotate in (rotator):**
1. Tap **Open manage page** and subscribe on the service's site.
2. Back in the app, tap **Mark subscribed** (records the charge).
3. The app immediately prompts "Cancel auto-renew now?" with the manage link.
   - For a backfill whose renewal date has passed, the prompt follows Mark subscribed for any role and asks whether the period ended back then. Cancelling it there stops the next load from recording its renewals. "Not now" leaves it renewing.
4. Tap **Mark cancelled** and confirm `access_ends_on`.
5. The service shows "Active until {date}".

**Keeper renewal:** the Decide-by warning appears. If you do nothing, catch-up records the renewal charge on the renewal date. If the price changed, edit that charge's amount and tick **Also set as current price**. To drop the keeper, cancel via the manage link and **Mark cancelled**.

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

**Added in v1.5**
17. **Mark subscribed** with "Also set as current price" ticked records the charge and updates `price_cents` and `price_checked_on` together. If any part fails, nothing is saved.
18. **Delete period** removes the period and all its charges, and nothing else. Spend no longer counts them.

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
- Item 1 shows live progress: how many non-archived services have a price.
- The checklist can be dismissed (remembered per device) and reopened from the dashboard.

1. For each service, confirm `billing_interval` *before* marking it subscribed: renewal dates and charges depend on it. Enter the price here, or in Mark subscribed (§7.3). A statement is the best source.
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
