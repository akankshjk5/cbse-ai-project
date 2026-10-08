-- Tighten the API-facing grants created by Supabase's default privileges.
-- RLS already rejects these writes, but the media queue intentionally exposes
-- mutation only through its authenticated cancel/retry RPCs.

revoke all on table public.media_jobs from anon;
revoke update, delete, truncate, references, trigger
  on table public.media_jobs from authenticated;
grant select, insert on table public.media_jobs to authenticated;
grant select, insert, update, delete on table public.media_jobs to service_role;
-- Anonymous visitors may read explicitly shared presentations, but never
-- write them even if a future RLS policy is accidentally broadened.
revoke all on table public.presentations from anon;
grant select on table public.presentations to anon;
