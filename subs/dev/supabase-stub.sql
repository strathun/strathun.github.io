-- Just enough of Supabase for plain Postgres to run schema.sql, the migrations and
-- rls-test.sql (see sql-check.sh). Not part of the app; never run it on Supabase.
--
-- Mirrors: the anon / authenticated / service_role roles, auth.users, auth.uid()
-- (reads the JWT claims the test sets), and Supabase's default grants, including
-- execute on new functions for anon, so revoking that is really tested.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('create role %I nologin', r);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
