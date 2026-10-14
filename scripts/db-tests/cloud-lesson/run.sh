#!/usr/bin/env bash
# Applies every migration to a throwaway local Postgres 16 (with pgvector) and
# runs the cloud-lesson behaviour tests against it. Never points at Supabase.
#
#   PGHOST=/tmp PGPORT=55432 PGUSER=postgres scripts/db-tests/cloud-lesson/run.sh
#
# It also proves the cloud migration changes nothing that already existed: the
# schema is dumped just before and just after it, and any removed line fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
db="${DBTEST_NAME:-lumina_cloud_lesson_test}"
work="$(mktemp -d)"
P=(psql -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null
"${P[@]}" -d "$db" -f "$here/supabase_stub.sql" >/dev/null 2>&1
for f in "$root"/supabase/migrations/*.sql; do
  if [[ "$(basename "$f")" == 20261010120000_cloud_lesson_engine.sql ]]; then
    pg_dump -s --restrict-key=x "$db" > "$work/before.sql"
  fi
  "${P[@]}" -1 -d "$db" -f "$f" >/dev/null 2>"$work/err" || { echo "migration failed: $(basename "$f")"; cat "$work/err"; exit 1; }
done
pg_dump -s --restrict-key=x "$db" > "$work/after.sql"
removed=$(diff "$work/before.sql" "$work/after.sql" | grep -c '^<' || true)
if [[ "$removed" != 0 ]]; then echo "cloud migration changed existing schema ($removed lines)"; exit 1; fi
echo "migrations applied; existing schema unchanged"
"${P[@]}" -t -d "$db" -f "$here/test_cloud_lesson.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  //' | grep -v '^\s*$'
