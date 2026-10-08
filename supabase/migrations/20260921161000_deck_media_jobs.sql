-- Durable GPU media queue for the Clerk-backed Lumina Deck Pro application.
--
-- This intentionally does not reuse public.media_jobs. That table belongs to
-- the older Supabase-Auth compatibility application and stores UUID user ids;
-- Pro stores Clerk subjects as text and authorises through clerk_user_id().

create table public.deck_media_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  deck_id uuid not null references public.decks (id) on delete cascade,
  slide_id uuid references public.slides (id) on delete set null,
  target_block integer check (target_block is null or target_block >= 0),

  kind text not null check (kind in ('image', 'video')),
  profile text not null check (profile in ('image-fast', 'video-fast')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  prompt text not null check (char_length(prompt) between 3 and 4000),
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

  constraint deck_media_jobs_profile_kind_check check (
    (kind = 'image' and profile = 'image-fast') or
    (kind = 'video' and profile = 'video-fast')
  ),
  constraint deck_media_jobs_video_source_check check (
    kind <> 'video' or source_image_url is not null
  )
);

create index deck_media_jobs_owner_created_idx
  on public.deck_media_jobs (owner_id, created_at desc);
create index deck_media_jobs_deck_created_idx
  on public.deck_media_jobs (deck_id, created_at desc);
create index deck_media_jobs_slide_idx
  on public.deck_media_jobs (slide_id) where slide_id is not null;
create index deck_media_jobs_queue_idx
  on public.deck_media_jobs (available_at, created_at) where status = 'queued';
create index deck_media_jobs_worker_idx
  on public.deck_media_jobs (worker_id, heartbeat_at) where status = 'processing';

create trigger deck_media_jobs_set_updated_at
  before update on public.deck_media_jobs
  for each row execute function public.set_updated_at();

alter table public.deck_media_jobs enable row level security;

create policy "deck media jobs: read own"
  on public.deck_media_jobs for select to authenticated
  using (
    owner_id = public.clerk_user_id()
    and public.is_deck_owner(deck_id)
  );

create policy "deck media jobs: create own"
  on public.deck_media_jobs for insert to authenticated
  with check (
    owner_id = public.clerk_user_id()
    and public.is_deck_owner(deck_id)
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
      slide_id is null
      or exists (
        select 1 from public.slides s
        where s.id = slide_id and s.deck_id = deck_media_jobs.deck_id
      )
    )
  );

revoke all on table public.deck_media_jobs from anon;
revoke all on table public.deck_media_jobs from authenticated;
grant select, insert on table public.deck_media_jobs to authenticated;
grant select, insert, update, delete on table public.deck_media_jobs to service_role;

-- SKIP LOCKED makes claiming atomic and remains correct if more workers are
-- added later. A five-minute stale heartbeat recovers interrupted Pods.
create or replace function public.claim_deck_media_job(p_worker_id text)
returns setof public.deck_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.deck_media_jobs
  set status = case when attempts < max_attempts then 'queued' else 'failed' end,
      available_at = case when attempts < max_attempts then now() else available_at end,
      worker_id = null,
      locked_at = null,
      error_code = 'worker_lost',
      error_message = 'Worker heartbeat expired; job recovered by queue.',
      completed_at = case when attempts >= max_attempts then now() else null end
  where status = 'processing'
    and coalesce(heartbeat_at, locked_at, started_at, created_at)
      < now() - interval '5 minutes';

  return query
  with candidate as (
    select id
    from public.deck_media_jobs
    where status = 'queued'
      and available_at <= now()
      and cancel_requested_at is null
      and attempts < max_attempts
    order by created_at
    for update skip locked
    limit 1
  )
  update public.deck_media_jobs j
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

create or replace function public.heartbeat_deck_media_job(
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
  update public.deck_media_jobs
  set heartbeat_at = now(), progress = greatest(progress, least(99, p_progress))
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.complete_deck_media_job(
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
  update public.deck_media_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      completed_at = now(),
      heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.fail_deck_media_job(
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
  update public.deck_media_jobs
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

create or replace function public.request_deck_media_job_cancel(p_job_id uuid)
returns setof public.deck_media_jobs
language sql
security definer
set search_path = public
as $$
  update public.deck_media_jobs
  set cancel_requested_at = now(),
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
  where id = p_job_id
    and owner_id = public.clerk_user_id()
    and public.is_deck_owner(deck_id)
    and status in ('queued', 'processing')
  returning *;
$$;

create or replace function public.retry_deck_media_job(p_job_id uuid)
returns setof public.deck_media_jobs
language sql
security definer
set search_path = public
as $$
  update public.deck_media_jobs
  set status = 'queued',
      progress = 0,
      attempts = 0,
      available_at = now(),
      worker_id = null,
      locked_at = null,
      heartbeat_at = null,
      cancel_requested_at = null,
      error_code = null,
      error_message = null,
      output_url = null,
      output_metadata = '{}'::jsonb,
      started_at = null,
      completed_at = null
  where id = p_job_id
    and owner_id = public.clerk_user_id()
    and public.is_deck_owner(deck_id)
    and status = 'failed'
  returning *;
$$;

revoke all on function public.claim_deck_media_job(text) from public, anon, authenticated;
revoke all on function public.heartbeat_deck_media_job(uuid, text, smallint) from public, anon, authenticated;
revoke all on function public.complete_deck_media_job(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_deck_media_job(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_deck_media_job(text) to service_role;
grant execute on function public.heartbeat_deck_media_job(uuid, text, smallint) to service_role;
grant execute on function public.complete_deck_media_job(uuid, text, text, jsonb) to service_role;
grant execute on function public.fail_deck_media_job(uuid, text, text, text, integer) to service_role;

revoke all on function public.request_deck_media_job_cancel(uuid) from public, anon;
revoke all on function public.retry_deck_media_job(uuid) from public, anon;
grant execute on function public.request_deck_media_job_cancel(uuid) to authenticated;
grant execute on function public.retry_deck_media_job(uuid) to authenticated;

-- Videos share the same public CDN bucket and deck-id path contract as images.
update storage.buckets
set file_size_limit = 104857600,
    allowed_mime_types = array[
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'video/mp4', 'video/webm'
    ]
where id = 'deck-assets';
