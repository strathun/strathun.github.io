#!/usr/bin/env bash
# Runs subs/schema.sql, subs/migrations/*.sql and subs/rls-test.sql against a
# throwaway local Postgres database that stands in for Supabase (supabase-stub.sql).
# Everything runs twice, because both files promise they're safe to re-run.
#
# Needs Postgres 15+ and psql. Connects with the usual PG* variables
# (PGHOST, PGPORT, PGUSER) as a superuser. The database is dropped and recreated.
#
# Usage (from the repo root): bash subs/dev/sql-check.sh
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
cd "$(dirname "$0")/.."

DB="${SUBS_TEST_DB:-subs_rls_test}"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB"
run() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f dev/supabase-stub.sql
for pass in 1 2; do
  run -f schema.sql
  for f in migrations/*.sql; do run -f "$f"; done
done

result="$(run -At -f rls-test.sql | tail -n 1)"
echo "$result"
[ "$result" = "ALL RLS CHECKS PASSED" ]
