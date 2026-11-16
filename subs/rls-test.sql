-- RLS acceptance test for /subs/ (SPEC.md §10 criterion 1).
-- Run in Supabase → SQL Editor AFTER schema.sql. Everything runs inside a
-- transaction that is rolled back, so no data is left behind.
--
-- Pass: the last result is "ALL RLS CHECKS PASSED".
-- Fail: the run stops with an error naming the check that failed.

begin;

-- Two throwaway users (rolled back at the end).
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'rls-test-a@example.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'rls-test-b@example.invalid');

-- ── As user A: create one row in every table ────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';

insert into services (id, name, role) values
  ('11111111-0000-0000-0000-000000000001', 'RLS Test Service', 'rotator');
insert into periods (id, service_id, started_on, renews_on) values
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '2026-11-01', '2026-12-01');
insert into charges (service_id, period_id, charged_on, amount_cents, billing_interval) values
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', '2026-11-01', 1500, 'monthly');
insert into watchlist_items (service_id, title) values
  ('11111111-0000-0000-0000-000000000001', 'RLS test item');

do $$
begin
  assert (select count(*) from services)        = 1, 'A cannot read own services';
  assert (select count(*) from periods)         = 1, 'A cannot read own periods';
  assert (select count(*) from charges)         = 1, 'A cannot read own charges';
  assert (select count(*) from watchlist_items) = 1, 'A cannot read own watchlist_items';
  assert (select user_id from services) = 'aaaaaaaa-0000-0000-0000-000000000001',
         'user_id was not defaulted from auth.uid()';
end $$;

-- ── As user B: must see and change nothing of A's ───────────────────────────
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}';

do $$
declare n int;
begin
  assert (select count(*) from services)        = 0, 'B can read A''s services';
  assert (select count(*) from periods)         = 0, 'B can read A''s periods';
  assert (select count(*) from charges)         = 0, 'B can read A''s charges';
  assert (select count(*) from watchlist_items) = 0, 'B can read A''s watchlist_items';

  update services set name = 'pwned' where true;  get diagnostics n = row_count;
  assert n = 0, 'B can update A''s services';
  update charges set amount_cents = 0 where true; get diagnostics n = row_count;
  assert n = 0, 'B can update A''s charges';
  delete from periods where true;                  get diagnostics n = row_count;
  assert n = 0, 'B can delete A''s periods';
  delete from services where true;                 get diagnostics n = row_count;
  assert n = 0, 'B can delete A''s services';

  -- Writing a row stamped with A's user_id must fail (policy with check).
  begin
    insert into services (name, role, user_id)
      values ('spoof', 'keeper', 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'B inserted a row owned by A';
  exception when insufficient_privilege then null;
  end;

  -- Attaching B's own rows to A's service/period must fail (composite FK).
  -- The period is already cancelled so the one-open-period index doesn't
  -- reject it first; this isolates the FK check.
  begin
    insert into periods (service_id, started_on, cancelled_on, access_ends_on)
      values ('11111111-0000-0000-0000-000000000001', '2026-10-01', '2026-10-01', '2026-10-31');
    raise exception 'B attached a period to A''s service';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into watchlist_items (service_id, title)
      values ('11111111-0000-0000-0000-000000000001', 'spoof');
    raise exception 'B attached a watchlist item to A''s service';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into charges (service_id, charged_on, billing_interval)
      values ('11111111-0000-0000-0000-000000000001', '2026-11-01', 'monthly');
    raise exception 'B attached a charge to A''s service';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ── As anon (signed out): no reads, no writes ───────────────────────────────
reset request.jwt.claims;
set local role anon;

do $$
begin
  assert (select count(*) from services)        = 0, 'anon can read services';
  assert (select count(*) from periods)         = 0, 'anon can read periods';
  assert (select count(*) from charges)         = 0, 'anon can read charges';
  assert (select count(*) from watchlist_items) = 0, 'anon can read watchlist_items';
  begin
    insert into services (name, role, user_id)
      values ('anon', 'keeper', 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'anon inserted a service';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── Back to A: data constraints ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
begin
  assert (select name from services) = 'RLS Test Service', 'B''s update leaked through';

  -- Second uncancelled period for the same service (acceptance 7).
  begin
    insert into periods (service_id, started_on)
      values ('11111111-0000-0000-0000-000000000001', '2026-11-05');
    raise exception 'two uncancelled periods allowed';
  exception when unique_violation then null;
  end;

  -- Duplicate catch-up charge (acceptance 9).
  begin
    insert into charges (service_id, period_id, charged_on, amount_cents, billing_interval, source)
      values ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001',
              '2026-11-01', 1500, 'monthly', 'auto');
    raise exception 'duplicate charge for same period/date allowed';
  exception when unique_violation then null;
  end;

  -- Duplicate service name, case-insensitive (acceptance 2).
  begin
    insert into services (name, role) values ('rls test service', 'keeper');
    raise exception 'duplicate service name allowed';
  exception when unique_violation then null;
  end;

  -- Deleting a period keeps its charges, nulling only period_id.
  delete from periods where id = '22222222-0000-0000-0000-000000000001';
  assert (select count(*) from charges where period_id is null) = 1,
         'charge not kept / period_id not nulled on period delete';
  assert (select user_id from charges) = 'aaaaaaaa-0000-0000-0000-000000000001',
         'user_id was nulled on period delete';

  -- Deleting a service cascades to its children (acceptance 4).
  delete from services where id = '11111111-0000-0000-0000-000000000001';
  assert (select count(*) from charges) = 0,         'charges not cascaded';
  assert (select count(*) from watchlist_items) = 0, 'watchlist_items not cascaded';
end $$;

select 'ALL RLS CHECKS PASSED' as result;

rollback;
