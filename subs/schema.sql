-- Subscription Rotation Tracker — schema + RLS (SPEC.md §6)
-- Run in Supabase → SQL Editor. Safe to re-run.
--
-- Security model: every table carries user_id (defaulted from the JWT) and is
-- protected by RLS. Child tables reference their parent with a composite FK on
-- (id, user_id), so a user can never attach a row to another user's service or
-- period even though the policy only checks the row being written.

-- ── services ────────────────────────────────────────────────────────────────
create table if not exists services (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  category         text check (category in ('video','music','gaming','storage','shopping','ai','other')),
  role             text not null check (role in ('keeper','rotator')),
  billing_interval text not null default 'monthly'
                   check (billing_interval in ('weekly','monthly','quarterly','annual')),
  price_cents      int  check (price_cents >= 0),
  price_checked_on date,
  manage_url       text,
  manage_path      text,
  help_url         text,
  url_verified     boolean not null default false,
  cancel_lead_days int  not null default 1 check (cancel_lead_days >= 0),
  notes            text,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (id, user_id)                       -- target for child composite FKs
);

-- Starter list inserts exactly once; no duplicate names per user.
create unique index if not exists services_user_name_uq on services (user_id, lower(name));

-- ── periods ─────────────────────────────────────────────────────────────────
create table if not exists periods (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id     uuid not null,
  started_on     date not null,
  renews_on      date,
  cancelled_on   date,
  access_ends_on date,
  foreign key (service_id, user_id) references services (id, user_id) on delete cascade,
  unique (id, service_id, user_id),          -- target for charges composite FK
  check (renews_on      is null or renews_on      >  started_on),
  check (cancelled_on   is null or cancelled_on   >= started_on),
  check (access_ends_on is null or access_ends_on >= started_on)
);

-- At most one uncancelled period per service (SPEC §6, acceptance 7).
create unique index if not exists periods_one_open_per_service
  on periods (service_id) where cancelled_on is null;
create index if not exists periods_user_idx on periods (user_id);

-- ── charges ─────────────────────────────────────────────────────────────────
create table if not exists charges (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id       uuid not null,
  period_id        uuid,
  charged_on       date not null,
  amount_cents     int  check (amount_cents >= 0),     -- null = unknown, excluded from totals
  billing_interval text not null
                   check (billing_interval in ('weekly','monthly','quarterly','annual')),
  source           text not null default 'manual' check (source in ('manual','auto')),
  foreign key (service_id, user_id) references services (id, user_id) on delete cascade,
  -- Period must belong to the same service and user. Deleting the period nulls
  -- only period_id (PG15+ column list), keeping the charge for spend history.
  foreign key (period_id, service_id, user_id)
    references periods (id, service_id, user_id) on delete set null (period_id)
);

-- Makes automatic renewal catch-up idempotent across reloads/tabs (acceptance 9).
create unique index if not exists charges_period_date_uq on charges (period_id, charged_on);
create index if not exists charges_service_idx on charges (service_id);
create index if not exists charges_user_date_idx on charges (user_id, charged_on);

-- ── watchlist_items ─────────────────────────────────────────────────────────
create table if not exists watchlist_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id     uuid not null,
  title          text not null check (length(btrim(title)) > 0),
  available_from date,
  done_at        timestamptz,
  sort_order     int not null default 0,
  foreign key (service_id, user_id) references services (id, user_id) on delete cascade
);

create index if not exists watchlist_service_idx on watchlist_items (service_id);
create index if not exists watchlist_user_idx on watchlist_items (user_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- (select auth.uid()) is evaluated once per query rather than per row.
do $$
declare t text;
begin
  foreach t in array array['services','periods','charges','watchlist_items'] loop
    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists "own rows select" on %I', t);
    execute format('drop policy if exists "own rows insert" on %I', t);
    execute format('drop policy if exists "own rows update" on %I', t);
    execute format('drop policy if exists "own rows delete" on %I', t);

    execute format($p$create policy "own rows select" on %I for select to authenticated
                      using ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "own rows insert" on %I for insert to authenticated
                      with check ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "own rows update" on %I for update to authenticated
                      using ((select auth.uid()) = user_id)
                      with check ((select auth.uid()) = user_id)$p$, t);
    execute format($p$create policy "own rows delete" on %I for delete to authenticated
                      using ((select auth.uid()) = user_id)$p$, t);
  end loop;
end $$;
