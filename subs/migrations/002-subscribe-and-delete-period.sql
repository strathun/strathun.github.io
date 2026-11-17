-- Subscription tracker — migration 002: writes that must succeed or fail together (SPEC §6).
-- Run in Supabase → SQL Editor after schema.sql. Safe to re-run.
-- Then run rls-test.sql: its last row must read ALL RLS CHECKS PASSED.
--
-- Each function runs in one transaction: if any statement fails, nothing it wrote
-- is kept. Both are security invoker, so they run as the signed-in user and the
-- RLS policies and composite foreign keys in schema.sql still apply to every row.
-- The page calls them with sb.rpc() (subs/db.js).
--
-- Errors the page explains: no_data_found (P0002) = not visible to this user;
-- invalid_parameter_value (22023) = refused input; unique_violation (23505) =
-- the service already has an uncancelled period.

-- ── Mark subscribed (SPEC §7.3) ─────────────────────────────────────────────
-- Inserts the period and its first charge, and with p_set_price saves the amount
-- as the service's current price. The page computes renews_on (logic/periods.js)
-- and sends the billing interval it used; if the service's interval changed since
-- the page loaded, the call is refused instead of recording a wrong renewal date.
create or replace function public.mark_subscribed(
  p_service_id       uuid,
  p_started_on       date,
  p_renews_on        date,
  p_billing_interval text,
  p_amount_cents     int,
  p_set_price        boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_service public.services;
  v_period  public.periods;
  v_charge  public.charges;
begin
  select * into v_service from public.services where id = p_service_id;
  if not found then
    raise exception 'service not found, or not yours' using errcode = 'no_data_found';
  end if;
  -- An archived service shows no alerts, so it must not start renewing (SPEC §8.4).
  if v_service.archived_at is not null then
    raise exception 'restore the service before marking it subscribed' using errcode = 'invalid_parameter_value';
  end if;
  if v_service.billing_interval is distinct from p_billing_interval then
    raise exception 'its billing interval changed since the page loaded. reload and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_set_price and p_amount_cents is null then
    raise exception 'enter the amount to save it as the price' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.periods (service_id, started_on, renews_on)
  values (p_service_id, p_started_on, p_renews_on)
  returning * into v_period;

  insert into public.charges (service_id, period_id, charged_on, amount_cents, billing_interval, source)
  values (p_service_id, v_period.id, p_started_on, p_amount_cents, p_billing_interval, 'manual')
  returning * into v_charge;

  if p_set_price then
    update public.services
       set price_cents = p_amount_cents, price_checked_on = p_started_on
     where id = p_service_id
    returning * into v_service;
    if not found then
      raise exception 'service not found, or not yours' using errcode = 'no_data_found';
    end if;
  end if;

  return jsonb_build_object(
    'period',  to_jsonb(v_period),
    'charge',  to_jsonb(v_charge),
    'service', to_jsonb(v_service)
  );
end $$;

-- ── Delete period (SPEC §8.3) ───────────────────────────────────────────────
-- Removes the period and every charge in it, and nothing else. Returns the
-- deleted period and the ids of the deleted charges.
create or replace function public.delete_period(p_period_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_period     public.periods;
  v_charge_ids uuid[];
begin
  -- Charges first: deleting the period alone would only null their period_id (schema.sql).
  with gone as (
    delete from public.charges where period_id = p_period_id returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_charge_ids from gone;

  delete from public.periods where id = p_period_id returning * into v_period;
  if not found then
    raise exception 'period not found, or not yours' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object('period', to_jsonb(v_period), 'charge_ids', to_jsonb(v_charge_ids));
end $$;

-- ── Who may call them ───────────────────────────────────────────────────────
-- Supabase grants execute on new functions to anon by default. Signed-out
-- callers would be stopped by RLS anyway; this stops them at the door.
revoke all on function public.mark_subscribed(uuid, date, date, text, int, boolean) from public, anon;
grant execute on function public.mark_subscribed(uuid, date, date, text, int, boolean) to authenticated;
revoke all on function public.delete_period(uuid) from public, anon;
grant execute on function public.delete_period(uuid) to authenticated;

-- Let the API see the new functions now instead of after its next schema refresh.
notify pgrst, 'reload schema';
