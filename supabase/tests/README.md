# Database tests

Executed against **PostgreSQL 18.1** on 2026-10-15. Not parse-checks — these
ran, and the results are in the Step-3 report.

## Running them

Supabase local (`npm run db:start`) needs Docker. Where Docker is unavailable,
any PostgreSQL 15+ works with the shim:

```bash
createdb lumina_test
psql -d lumina_test -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -d lumina_test -v ON_ERROR_STOP=1 -f "$f"; done
psql -d lumina_test -f supabase/tests/reuse_concurrency.sql
```

`00_supabase_shim.sql` provides only what the migrations reference and Supabase
would otherwise supply: the `anon`/`authenticated`/`service_role` roles, the
`extensions`/`auth`/`storage`/`private` schemas, `auth.jwt()` and `auth.uid()`
backed by the `request.jwt.claims` GUC, `storage.buckets`/`objects`,
`storage.foldername()`, `auth.users`, and the `supabase_realtime` publication.
It is test scaffolding and is never applied to a real environment.

`public.test_become('user_id')` sets the JWT claim so a test can act as a
given Clerk user.

## Known gap

`20260827000500_rag.sql` is **skipped**: it needs pgvector, which was not
installed. It creates the `documents`/`document_chunks` tables and no code
queries them, so skipping it does not affect the reuse or cost paths. The
`document_source` enum it would create is declared in the shim instead, because
`20260827000700_ppt_import_export.sql` references the enum but not the vector
column.

With that one skip, **29 of 30 migrations apply cleanly**.
