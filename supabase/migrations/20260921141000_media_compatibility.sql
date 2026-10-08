-- Compatibility layer for the current Lumina Deck checkout.
--
-- The existing lumina_dep project uses Clerk identities and normalized
-- decks/slides tables. This checkout uses Supabase Auth and a JSON-backed
-- presentations table. Keep both models isolated: do not alter or replace the
-- existing decks, slides, generation_jobs, or Clerk RLS policies.

-- The existing text primary key accepts either a Clerk subject or a Supabase
-- Auth UUID serialized as text. Its existing clerk_user_id() policy compares
-- the raw JWT sub and therefore works for both identity providers.
alter table public.profiles add column if not exists class text;
alter table public.profiles add column if not exists board text;
alter table public.profiles add column if not exists full_name text;
create table if not exists public.presentations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled Presentation',
  theme text not null default 'modern',
  blocks_json jsonb not null default '[]'::jsonb,
  is_public boolean not null default false,
  subject text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists presentations_user_updated_idx
  on public.presentations (user_id, updated_at desc);
drop trigger if exists presentations_set_updated_at on public.presentations;
create trigger presentations_set_updated_at
  before update on public.presentations
  for each row execute function public.set_updated_at();
alter table public.presentations enable row level security;
drop policy if exists "presentations read own or public" on public.presentations;
drop policy if exists "presentations insert own" on public.presentations;
drop policy if exists "presentations update own" on public.presentations;
drop policy if exists "presentations delete own" on public.presentations;
create policy "presentations read own or public" on public.presentations
  for select to anon, authenticated
  using (auth.uid() = user_id or is_public = true);
create policy "presentations insert own" on public.presentations
  for insert to authenticated with check (auth.uid() = user_id);
create policy "presentations update own" on public.presentations
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "presentations delete own" on public.presentations
  for delete to authenticated using (auth.uid() = user_id);
grant select on public.presentations to anon;
grant select, insert, update, delete on public.presentations to authenticated;
-- Durable asynchronous media-generation queue.
-- The browser may create/read/cancel its own jobs through RLS. Only the
-- service-role GPU worker can claim or complete work.

create extension if not exists pgcrypto with schema extensions;
-- Shared decks need their generated media to resolve without an authenticated
-- browser session. Writes remain owner-scoped by the storage policies below;
-- the service-role worker bypasses RLS and writes to the same user prefix.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'presentation-media',
  'presentation-media',
  true,
  104857600,
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/avif', 'image/svg+xml', 'video/mp4', 'video/webm'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "presentation media insert own folder" on storage.objects;
drop policy if exists "presentation media update own folder" on storage.objects;
drop policy if exists "presentation media delete own folder" on storage.objects;
create policy "presentation media insert own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'presentation-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "presentation media update own folder" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'presentation-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'presentation-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "presentation media delete own folder" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'presentation-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create table if not exists public.media_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  presentation_id uuid references public.presentations(id) on delete set null,

  kind text not null check (kind in ('image', 'video')),
  profile text not null check (profile in ('image-fast', 'video-fast', 'video-quality')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  negative_prompt text not null default '' check (char_length(negative_prompt) <= 2000),
  source_image_url text,
  parameters jsonb not null default '{}'::jsonb,

  progress smallint not null default 0 check (progress between 0 and 100),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 2 check (max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  worker_id text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,

  output_url text,
  output_metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,

  constraint media_jobs_profile_kind_check check (
    (kind = 'image' and profile = 'image-fast') or
    (kind = 'video' and profile in ('video-fast', 'video-quality'))
  ),
  constraint media_jobs_video_source_check check (
    kind <> 'video' or source_image_url is not null
  )
);
create index if not exists media_jobs_user_created_idx
  on public.media_jobs (user_id, created_at desc);
create index if not exists media_jobs_queue_idx
  on public.media_jobs (available_at, created_at)
  where status = 'queued';
create index if not exists media_jobs_worker_idx
  on public.media_jobs (worker_id, heartbeat_at)
  where status = 'processing';
create or replace function public.touch_media_job_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists media_jobs_touch_updated_at on public.media_jobs;
create trigger media_jobs_touch_updated_at
  before update on public.media_jobs
  for each row execute function public.touch_media_job_updated_at();
alter table public.media_jobs enable row level security;
drop policy if exists "media jobs read own" on public.media_jobs;
drop policy if exists "media jobs create own" on public.media_jobs;
create policy "media jobs read own" on public.media_jobs
  for select using (auth.uid() = user_id);
create policy "media jobs create own" on public.media_jobs
  for insert with check (
    auth.uid() = user_id
    and status = 'queued'
    and progress = 0
    and attempts = 0
    and max_attempts = 2
    and worker_id is null
    and locked_at is null
    and heartbeat_at is null
    and cancel_requested_at is null
    and output_url is null
    and output_metadata = '{}'::jsonb
    and error_code is null
    and error_message is null
    and started_at is null
    and completed_at is null
    and (
      presentation_id is null
      or exists (
        select 1 from public.presentations p
        where p.id = presentation_id and p.user_id = auth.uid()
      )
    )
  );
grant select, insert on public.media_jobs to authenticated;
grant select, insert, update, delete on public.media_jobs to service_role;
-- Atomically reserve one queued job. SKIP LOCKED makes this safe if a second
-- worker is added later while still preserving concurrency=1 per worker.
create or replace function public.claim_media_job(p_worker_id text)
returns setof public.media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A killed Pod must not strand work forever. A healthy worker heartbeats
  -- every ten seconds; five minutes is deliberately conservative.
  update public.media_jobs
  set status = case when attempts < max_attempts then 'queued' else 'failed' end,
      available_at = case when attempts < max_attempts then now() else available_at end,
      worker_id = null,
      locked_at = null,
      error_code = 'worker_lost',
      error_message = 'Worker heartbeat expired; job recovered by queue.',
      completed_at = case when attempts >= max_attempts then now() else null end
  where status = 'processing'
    and coalesce(heartbeat_at, locked_at, started_at, created_at) < now() - interval '5 minutes';

  return query
  with candidate as (
    select id
    from public.media_jobs
    where status = 'queued'
      and available_at <= now()
      and cancel_requested_at is null
      and attempts < max_attempts
    order by created_at
    for update skip locked
    limit 1
  )
  update public.media_jobs j
  set status = 'processing',
      progress = greatest(j.progress, 1),
      attempts = j.attempts + 1,
      worker_id = p_worker_id,
      locked_at = now(),
      heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()),
      error_code = null,
      error_message = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;
create or replace function public.heartbeat_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_progress smallint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.media_jobs
  set heartbeat_at = now(), progress = greatest(progress, least(99, p_progress))
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
create or replace function public.complete_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_output_url text,
  p_output_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.media_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      completed_at = now(), heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
create or replace function public.fail_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry_delay_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.media_jobs
  set status = case
        when cancel_requested_at is not null then 'cancelled'
        when attempts < max_attempts then 'queued'
        else 'failed'
      end,
      available_at = case
        when cancel_requested_at is null and attempts < max_attempts
          then now() + make_interval(secs => greatest(1, p_retry_delay_seconds))
        else available_at
      end,
      worker_id = null,
      locked_at = null,
      heartbeat_at = now(),
      error_code = left(p_error_code, 100),
      error_message = left(p_error_message, 2000),
      completed_at = case
        when cancel_requested_at is not null or attempts >= max_attempts then now()
        else null
      end
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
create or replace function public.request_media_job_cancel(p_job_id uuid)
returns setof public.media_jobs
language sql
security definer
set search_path = public
as $$
  update public.media_jobs
  set cancel_requested_at = now(),
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
  where id = p_job_id
    and user_id = auth.uid()
    and status in ('queued', 'processing')
  returning *;
$$;
create or replace function public.retry_media_job(p_job_id uuid)
returns setof public.media_jobs
language sql
security definer
set search_path = public
as $$
  update public.media_jobs
  set status = 'queued', progress = 0, attempts = 0, available_at = now(),
      worker_id = null, locked_at = null, heartbeat_at = null,
      cancel_requested_at = null, error_code = null, error_message = null,
      output_url = null, output_metadata = '{}'::jsonb,
      started_at = null, completed_at = null
  where id = p_job_id and user_id = auth.uid() and status = 'failed'
  returning *;
$$;
revoke all on function public.claim_media_job(text) from public, anon, authenticated;
revoke all on function public.heartbeat_media_job(uuid, text, smallint) from public, anon, authenticated;
revoke all on function public.complete_media_job(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_media_job(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_media_job(text) to service_role;
grant execute on function public.heartbeat_media_job(uuid, text, smallint) to service_role;
grant execute on function public.complete_media_job(uuid, text, text, jsonb) to service_role;
grant execute on function public.fail_media_job(uuid, text, text, text, integer) to service_role;
revoke all on function public.request_media_job_cancel(uuid) from public, anon;
revoke all on function public.retry_media_job(uuid) from public, anon;
grant execute on function public.request_media_job_cancel(uuid) to authenticated;
grant execute on function public.retry_media_job(uuid) to authenticated;
