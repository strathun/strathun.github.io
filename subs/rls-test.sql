-- RLS acceptance test for /subs/ (SPEC.md §10 criteria 1, 17, 18).
-- Run in Supabase → SQL Editor AFTER schema.sql and migrations/*.sql. Everything
-- runs inside a transaction that is rolled back, so no data is left behind.
-- To run it on a local Postgres instead, see subs/dev/README.md (sql-check.sh).
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

  -- The migration 002 functions run as the caller (security invoker): A's rows stay invisible.
  begin
    perform mark_subscribed('11111111-0000-0000-0000-000000000001', '2026-11-02', '2026-12-02', 'monthly', 100, true);
    raise exception 'B marked A''s service subscribed';
  exception when no_data_found then null;
  end;
  begin
    perform delete_period('22222222-0000-0000-0000-000000000001');
    raise exception 'B deleted A''s period';
  exception when no_data_found then null;
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
  begin
    perform mark_subscribed('11111111-0000-0000-0000-000000000001', '2026-11-02', '2026-12-02', 'monthly', 100, false);
    raise exception 'anon ran mark_subscribed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform delete_period('22222222-0000-0000-0000-000000000001');
    raise exception 'anon ran delete_period';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── Back to A: data constraints ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
begin
  assert (select name from services) = 'RLS Test Service', 'B''s update leaked through';
  assert (select count(*) from periods) = 1 and (select count(*) from charges) = 1,
         'B''s delete_period leaked through';

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

-- ── Still A: transactional writes (migration 002, acceptance 17 and 18) ─────
do $$
declare
  r     jsonb;
  svc   uuid := '33333333-0000-0000-0000-000000000001';
  other uuid := '33333333-0000-0000-0000-000000000002';
  per   uuid;
begin
  assert not exists (select 1 from pg_proc where proname in ('mark_subscribed', 'delete_period') and prosecdef),
         'migration 002 functions must be security invoker';

  insert into services (id, name, role, billing_interval) values
    (svc,   'RLS Txn Service', 'keeper',  'monthly'),
    (other, 'RLS Txn Other',   'rotator', 'monthly');

  -- Mark subscribed with "also set as current price": period, charge and price together.
  r := mark_subscribed(svc, '2026-10-05', '2026-11-05', 'monthly', 1299, true);
  per := (r -> 'period' ->> 'id')::uuid;
  assert (select count(*) from periods where service_id = svc) = 1, 'mark_subscribed: no period';
  assert (select renews_on from periods where id = per) = '2026-11-05', 'mark_subscribed: wrong renews_on';
  assert (select count(*) from charges where period_id = per and charged_on = '2026-10-05'
            and amount_cents = 1299 and source = 'manual' and billing_interval = 'monthly') = 1,
         'mark_subscribed: charge missing or wrong';
  assert (select price_cents = 1299 and price_checked_on = '2026-10-05' from services where id = svc),
         'mark_subscribed: price not set';
  assert (r -> 'service' ->> 'price_cents')::int = 1299 and (r -> 'charge' ->> 'period_id')::uuid = per,
         'mark_subscribed: returned rows are wrong';

  -- A second open period is refused, and nothing else changes (acceptance 7).
  begin
    perform mark_subscribed(svc, '2026-11-01', '2026-12-01', 'monthly', 999, true);
    raise exception 'two uncancelled periods allowed via mark_subscribed';
  exception when unique_violation then null;
  end;
  assert (select count(*) from charges where service_id = svc) = 1, 'refused mark_subscribed left a charge';
  assert (select price_cents from services where id = svc) = 1299, 'refused mark_subscribed changed the price';

  -- Catch-up's insert ... on conflict do nothing skips a renewal already recorded (acceptance 9).
  insert into charges (service_id, period_id, charged_on, amount_cents, billing_interval, source)
    values (svc, per, '2026-11-05', 1299, 'monthly', 'auto');
  insert into charges (service_id, period_id, charged_on, amount_cents, billing_interval, source)
    values (svc, per, '2026-11-05', 1299, 'monthly', 'auto')
    on conflict (period_id, charged_on) do nothing;
  assert (select count(*) from charges where period_id = per) = 2, 'on conflict did not skip the duplicate';

  -- A failure after the period insert rolls the period back too (acceptance 17).
  update periods set cancelled_on = '2026-11-06', access_ends_on = '2026-12-04' where id = per;
  begin
    perform mark_subscribed(svc, '2026-11-10', '2026-12-10', 'monthly', -1, true);  -- charge check fails
    raise exception 'negative amount accepted';
  exception when check_violation then null;
  end;
  assert (select count(*) from periods where service_id = svc) = 1, 'failed mark_subscribed left a period';
  assert (select price_cents from services where id = svc) = 1299, 'failed mark_subscribed changed the price';

  -- Refused input writes nothing.
  begin
    perform mark_subscribed(svc, '2026-11-10', '2026-11-17', 'weekly', 500, false);
    raise exception 'stale billing interval accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform mark_subscribed(svc, '2026-11-10', '2026-12-10', 'monthly', null, true);
    raise exception 'set price without an amount accepted';
  exception when invalid_parameter_value then null;
  end;
  update services set archived_at = now() where id = other;
  begin
    perform mark_subscribed(other, '2026-11-10', '2026-12-10', 'monthly', 500, false);
    raise exception 'archived service marked subscribed';
  exception when invalid_parameter_value then null;
  end;
  update services set archived_at = null where id = other;
  assert (select count(*) from periods where service_id in (svc, other)) = 1, 'refused input left a period';

  -- Without "set price", an unknown amount is recorded as null and the price is untouched.
  r := mark_subscribed(other, '2026-11-10', '2026-12-10', 'monthly', null, false);
  assert (r -> 'charge' -> 'amount_cents') = 'null'::jsonb, 'unknown amount not recorded as null';
  assert (select price_cents from services where id = other) is null, 'price changed without set price';

  -- Delete period removes the period and all its charges, and nothing else (acceptance 18).
  insert into charges (service_id, charged_on, amount_cents, billing_interval)
    values (svc, '2026-01-05', 1000, 'monthly');   -- in no period
  r := delete_period(per);
  assert jsonb_array_length(r -> 'charge_ids') = 2, 'delete_period: wrong charges reported';
  assert not exists (select 1 from periods where id = per), 'delete_period: period kept';
  assert (select count(*) from charges where service_id = svc) = 1, 'delete_period: removed the wrong charges';
  assert (select count(*) from charges where service_id = other) = 1, 'delete_period touched another service';
  assert (select price_cents from services where id = svc) = 1299, 'delete_period changed the service';
  begin
    perform delete_period(per);
    raise exception 'deleting a missing period succeeded';
  exception when no_data_found then null;
  end;
end $$;

select 'ALL RLS CHECKS PASSED' as result;

rollback;
