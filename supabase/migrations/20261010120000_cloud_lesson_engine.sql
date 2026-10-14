-- ─────────────────────────────────────────────────────────────────────────────
-- Cloud lesson engine (Gemini + Higgsfield) — schema, queue and storage
--
-- A SEPARATE engine from the RunPod narrated-lesson pipeline. Nothing in this
-- file reads, alters or replaces any existing object: the lesson_video_* tables,
-- their RPCs, their claim functions, the lesson-video-assets bucket and every
-- earlier migration are untouched. A RunPod worker can never see a cloud job and
-- a cloud worker can never see a RunPod job, because they live in different
-- tables.
--
-- Shape of a lesson:
--   cloud_lesson_projects  one row per requested lesson (60 s, en/hi/kn)
--   cloud_lesson_scenes    8 scenes of 7.5 s, each `animate` or `still`
--   cloud_lesson_jobs      the queue: prepare → image ×8 → video ×8 → assemble
--
-- Who calls what:
--   authenticated (Clerk token)  reserve_cloud_lesson, cancel_cloud_lesson,
--                                SELECT on own rows (RLS)
--   service_role (workers)       claim / heartbeat / complete / fail RPCs
--
-- Every SECURITY DEFINER function pins `search_path = ''`, schema-qualifies what
-- it touches, re-derives the caller's identity itself where a user calls it, and
-- has EXECUTE revoked from PUBLIC before being granted to exactly one role.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ───────────────────────────────────────────────────────────────────

create table public.cloud_lesson_projects (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  class_level smallint not null check (class_level between 1 and 12),
  subject text not null check (char_length(subject) between 2 and 100),
  topic text not null check (char_length(topic) between 3 and 300),
  -- The cloud engine ships three languages. Adding one is a new migration that
  -- widens this check, after its voice and caption font have been reviewed.
  language_code text not null check (language_code in ('en-IN', 'hi-IN', 'kn-IN')),
  -- 60 s only for now; 8 scenes of 7.5 s. Widen with the scene-count logic below.
  target_duration_seconds smallint not null default 60 check (target_duration_seconds in (60)),

  -- Filled in by the prepare job. Null until then, rather than placeholder text
  -- that a UI could mistake for real content.
  title text check (title is null or char_length(title) between 3 and 200),
  learning_objective text check (learning_objective is null or char_length(learning_objective) between 10 and 500),
  narration_text text check (narration_text is null or char_length(narration_text) between 20 and 8000),
  narration_url text check (narration_url is null or narration_url ~ '^https://'),
  narration_duration_seconds numeric(8,3),

  status text not null default 'preparing' check (status in (
    'preparing', 'generating_images', 'generating_videos', 'assembling',
    'succeeded', 'failed', 'cancelled'
  )),
  final_video_url text check (final_video_url is null or final_video_url ~ '^https://'),
  error_message text,

  -- What this lesson actually cost, summed by the workers from provider usage.
  -- cost_breakdown is keyed by job kind: {"prepare": 0.02, "image": 0.31, ...}.
  cost_usd numeric(10,4) not null default 0 check (cost_usd >= 0),
  cost_breakdown jsonb not null default '{}'::jsonb check (jsonb_typeof(cost_breakdown) = 'object'),

  -- Lesson cache keys (used by the cache lookup in a later part). Generated, so
  -- no caller can write a key that disagrees with the lesson it labels.
  --   content_key  the lesson's substance: class + subject + topic + length
  --   cache_key    content_key + language — an exact repeat
  content_key text generated always as (
    class_level::text || '|'
    || lower(regexp_replace(btrim(subject), '\s+', ' ', 'g')) || '|'
    || lower(regexp_replace(btrim(topic), '\s+', ' ', 'g')) || '|'
    || target_duration_seconds::text
  ) stored,
  cache_key text generated always as (
    class_level::text || '|'
    || lower(regexp_replace(btrim(subject), '\s+', ' ', 'g')) || '|'
    || lower(regexp_replace(btrim(topic), '\s+', ' ', 'g')) || '|'
    || target_duration_seconds::text || '|'
    || language_code
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index cloud_lesson_projects_owner_created_idx
  on public.cloud_lesson_projects (owner_id, created_at desc);
create index cloud_lesson_projects_active_idx
  on public.cloud_lesson_projects (owner_id)
  where status in ('preparing', 'generating_images', 'generating_videos', 'assembling');
create index cloud_lesson_projects_cache_idx
  on public.cloud_lesson_projects (cache_key, completed_at desc)
  where status = 'succeeded';
create index cloud_lesson_projects_content_idx
  on public.cloud_lesson_projects (content_key, completed_at desc)
  where status = 'succeeded';

create trigger cloud_lesson_projects_set_updated_at
  before update on public.cloud_lesson_projects
  for each row execute function public.set_updated_at();

create table public.cloud_lesson_scenes (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  scene_index smallint not null check (scene_index between 1 and 12),
  duration_seconds numeric(6,3) not null check (duration_seconds between 4 and 12),
  fact text not null check (char_length(fact) between 10 and 500),
  narration text not null check (char_length(narration) between 5 and 800),
  caption text not null default '' check (char_length(caption) <= 120),
  overlay jsonb not null default '{"kind":"none"}'::jsonb check (jsonb_typeof(overlay) = 'object'),
  visual_description text not null check (char_length(visual_description) between 20 and 1200),
  motion_description text not null check (char_length(motion_description) between 15 and 800),
  -- `animate` pays for a Higgsfield clip; `still` is animated by the compositor
  -- (slow camera move) at no generation cost. The scene director decides.
  motion_mode text not null default 'animate' check (motion_mode in ('animate', 'still')),
  image_prompt text not null check (char_length(image_prompt) between 20 and 4000),
  video_prompt text not null check (char_length(video_prompt) between 15 and 4000),
  status text not null default 'queued_image' check (status in (
    'queued_image', 'generating_image', 'queued_video', 'generating_video',
    'succeeded', 'failed', 'cancelled'
  )),
  image_url text,
  video_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, scene_index)  -- also serves as the project_id FK index
);

create trigger cloud_lesson_scenes_set_updated_at
  before update on public.cloud_lesson_scenes
  for each row execute function public.set_updated_at();

create table public.cloud_lesson_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  scene_id uuid references public.cloud_lesson_scenes (id) on delete cascade,
  kind text not null check (kind in ('prepare', 'image', 'video', 'assemble')),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'succeeded', 'failed', 'cancelled'
  )),
  prompt text not null default '' check (char_length(prompt) <= 4000),
  negative_prompt text not null default '' check (char_length(negative_prompt) <= 2000),
  source_image_url text check (source_image_url is null or source_image_url ~ '^https://'),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  -- The provider's own id for an in-flight generation (Higgsfield request_id).
  -- Kept across a worker crash, so the next worker resumes polling the request
  -- it already paid for instead of submitting — and paying for — a new one.
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  cost_usd numeric(10,4) not null default 0 check (cost_usd >= 0),
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
  constraint cloud_lesson_jobs_shape_check check (
    (kind = 'prepare' and scene_id is null)
    or (kind = 'image' and scene_id is not null and source_image_url is null)
    or (kind = 'video' and scene_id is not null and source_image_url is not null)
    or (kind = 'assemble' and scene_id is null)
  )
);

create index cloud_lesson_jobs_queue_idx
  on public.cloud_lesson_jobs (kind, available_at, created_at) where status = 'queued';
create index cloud_lesson_jobs_processing_idx
  on public.cloud_lesson_jobs (heartbeat_at) where status = 'processing';
create index cloud_lesson_jobs_project_idx
  on public.cloud_lesson_jobs (project_id, created_at);
create index cloud_lesson_jobs_scene_idx
  on public.cloud_lesson_jobs (scene_id) where scene_id is not null;
create index cloud_lesson_jobs_owner_idx
  on public.cloud_lesson_jobs (owner_id);
create unique index cloud_lesson_jobs_one_prepare_idx
  on public.cloud_lesson_jobs (project_id) where kind = 'prepare';
create unique index cloud_lesson_jobs_one_assemble_idx
  on public.cloud_lesson_jobs (project_id) where kind = 'assemble';

create trigger cloud_lesson_jobs_set_updated_at
  before update on public.cloud_lesson_jobs
  for each row execute function public.set_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
-- Owners may read their own rows. Nobody writes through the table API: every
-- change goes through the RPCs below, which validate the transition.

alter table public.cloud_lesson_projects enable row level security;
alter table public.cloud_lesson_scenes enable row level security;
alter table public.cloud_lesson_jobs enable row level security;

create policy "cloud lesson projects: read own"
  on public.cloud_lesson_projects for select to authenticated
  using (owner_id = (select public.clerk_user_id()));
create policy "cloud lesson scenes: read own"
  on public.cloud_lesson_scenes for select to authenticated
  using (exists (
    select 1 from public.cloud_lesson_projects p
    where p.id = project_id and p.owner_id = (select public.clerk_user_id())
  ));
create policy "cloud lesson jobs: read own"
  on public.cloud_lesson_jobs for select to authenticated
  using (owner_id = (select public.clerk_user_id()));

revoke all on table public.cloud_lesson_projects from public, anon, authenticated;
revoke all on table public.cloud_lesson_scenes from public, anon, authenticated;
revoke all on table public.cloud_lesson_jobs from public, anon, authenticated;
grant select on table public.cloud_lesson_projects to authenticated;
grant select on table public.cloud_lesson_scenes to authenticated;
grant select on table public.cloud_lesson_jobs to authenticated;
grant select, insert, update, delete on table public.cloud_lesson_projects to service_role;
grant select, insert, update, delete on table public.cloud_lesson_scenes to service_role;
grant select, insert, update, delete on table public.cloud_lesson_jobs to service_role;

-- ── Teacher-facing RPCs ──────────────────────────────────────────────────────

-- Saves a lesson request and queues its prepare job.
--
-- The per-teacher limits are enforced HERE, inside the same transaction as the
-- insert and behind a per-owner advisory lock, so two quick clicks cannot both
-- pass the count. They are constants rather than settings for the reason
-- src/lib/limits.ts gives: a limit that can be raised by configuration gets
-- raised in an incident and never lowered again. Mirror any change in
-- CLOUD_LESSON_LIMITS (src/lib/videos/cloud-lesson-contracts.ts).
create or replace function public.reserve_cloud_lesson(
  p_class_level smallint,
  p_subject text,
  p_topic text,
  p_language_code text,
  p_target_duration_seconds smallint default 60
)
returns setof public.cloud_lesson_projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_active constant integer := 2;
  c_max_per_day constant integer := 10;
  v_owner text := public.clerk_user_id();
  v_active integer;
  v_recent integer;
  v_project public.cloud_lesson_projects;
begin
  if v_owner is null then
    raise exception 'Sign in to generate a lesson.' using hint = 'cloud_lesson_auth';
  end if;
  if p_class_level is null or p_class_level not between 1 and 12 then
    raise exception 'Choose a class between 1 and 12.' using hint = 'cloud_lesson_invalid';
  end if;
  if char_length(btrim(coalesce(p_subject, ''))) not between 2 and 100 then
    raise exception 'Choose a subject.' using hint = 'cloud_lesson_invalid';
  end if;
  if char_length(btrim(coalesce(p_topic, ''))) not between 3 and 300 then
    raise exception 'Enter a topic of 3 to 300 characters.' using hint = 'cloud_lesson_invalid';
  end if;
  if p_language_code is null or p_language_code not in ('en-IN', 'hi-IN', 'kn-IN') then
    raise exception 'Choose English, Hindi or Kannada.' using hint = 'cloud_lesson_invalid';
  end if;
  if p_target_duration_seconds is distinct from 60 then
    raise exception 'Cloud lessons are 60 seconds long.' using hint = 'cloud_lesson_invalid';
  end if;

  -- Serialise this owner's reservations so the counts below cannot race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cloud_lesson_reserve:' || v_owner, 0)
  );

  select count(*) into v_active
  from public.cloud_lesson_projects
  where owner_id = v_owner
    and status in ('preparing', 'generating_images', 'generating_videos', 'assembling');
  if v_active >= c_max_active then
    raise exception 'You already have % lessons generating. Wait for one to finish.', c_max_active
      using hint = 'cloud_lesson_active_limit';
  end if;

  select count(*) into v_recent
  from public.cloud_lesson_projects
  where owner_id = v_owner and created_at > now() - interval '24 hours';
  if v_recent >= c_max_per_day then
    raise exception 'You have started % lessons in the last 24 hours, which is the daily limit.', c_max_per_day
      using hint = 'cloud_lesson_daily_limit';
  end if;

  insert into public.cloud_lesson_projects (
    owner_id, class_level, subject, topic, language_code, target_duration_seconds
  ) values (
    v_owner, p_class_level, btrim(p_subject), btrim(p_topic), p_language_code, p_target_duration_seconds
  ) returning * into v_project;

  insert into public.cloud_lesson_jobs (owner_id, project_id, kind, max_attempts, parameters)
  values (
    v_owner, v_project.id, 'prepare', 2,
    pg_catalog.jsonb_build_object(
      'classLevel', p_class_level,
      'subject', btrim(p_subject),
      'topic', btrim(p_topic),
      'languageCode', p_language_code,
      'targetDurationSeconds', p_target_duration_seconds
    )
  );

  return next v_project;
end;
$$;

-- Cancels a generating lesson the caller owns. Queued work stops at once;
-- a job already running is flagged and its worker stops at the next heartbeat.
create or replace function public.cancel_cloud_lesson(p_project_id uuid)
returns setof public.cloud_lesson_projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text := public.clerk_user_id();
  v_project public.cloud_lesson_projects;
begin
  if v_owner is null then return; end if;

  update public.cloud_lesson_projects
  set status = 'cancelled', completed_at = now(), error_message = null
  where id = p_project_id
    and owner_id = v_owner
    and status in ('preparing', 'generating_images', 'generating_videos', 'assembling')
  returning * into v_project;
  if not found then return; end if;

  update public.cloud_lesson_jobs
  set cancel_requested_at = now(),
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
  where project_id = p_project_id and status in ('queued', 'processing');

  update public.cloud_lesson_scenes
  set status = 'cancelled', completed_at = now()
  where project_id = p_project_id and status not in ('succeeded', 'failed', 'cancelled');

  return next v_project;
end;
$$;

-- ── Internal helpers (not exposed through the API) ──────────────────────────

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- Adds a job's spend to its lesson, both in total and under the job's kind.
create or replace function private.add_cloud_lesson_cost(
  p_project_id uuid,
  p_kind text,
  p_cost_usd numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_cost numeric := greatest(coalesce(p_cost_usd, 0), 0);
begin
  if v_cost = 0 then return; end if;
  update public.cloud_lesson_projects
  set cost_usd = cost_usd + v_cost,
      cost_breakdown = pg_catalog.jsonb_set(
        cost_breakdown,
        array[p_kind],
        pg_catalog.to_jsonb(round(coalesce((cost_breakdown ->> p_kind)::numeric, 0) + v_cost, 4))
      )
  where id = p_project_id;
end;
$$;

revoke all on function private.add_cloud_lesson_cost(uuid, text, numeric) from public, anon, authenticated;
grant execute on function private.add_cloud_lesson_cost(uuid, text, numeric) to service_role;

-- Fails a lesson and stops everything still queued for it.
create or replace function private.fail_cloud_lesson(p_project_id uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.cloud_lesson_projects
  set status = 'failed', error_message = left(p_message, 2000), completed_at = now()
  where id = p_project_id
    and status in ('preparing', 'generating_images', 'generating_videos', 'assembling');
  update public.cloud_lesson_jobs
  set status = 'cancelled', cancel_requested_at = now(), completed_at = now()
  where project_id = p_project_id and status = 'queued';
  update public.cloud_lesson_jobs
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where project_id = p_project_id and status = 'processing';
  update public.cloud_lesson_scenes
  set status = 'cancelled', completed_at = now()
  where project_id = p_project_id and status not in ('succeeded', 'failed', 'cancelled');
end;
$$;

revoke all on function private.fail_cloud_lesson(uuid, text) from public, anon, authenticated;
grant execute on function private.fail_cloud_lesson(uuid, text) to service_role;

-- ── Worker RPCs (service_role only) ──────────────────────────────────────────

-- Claims the oldest runnable job of the given kinds.
--
-- First recovers jobs whose worker stopped heartbeating for five minutes: back
-- to the queue while attempts remain (keeping provider_request_id, so a paid
-- Higgsfield request is resumed rather than repeated), otherwise failed along
-- with its lesson. Then claims one job with SKIP LOCKED, so any number of
-- worker processes can poll the same queue without blocking each other.
create or replace function public.claim_cloud_lesson_job(p_worker_id text, p_kinds text[])
returns setof public.cloud_lesson_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.cloud_lesson_jobs;
  v_lost record;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) < 3 then
    raise exception 'A worker id is required';
  end if;
  if p_kinds is null or cardinality(p_kinds) < 1
     or not (p_kinds <@ array['prepare', 'image', 'video', 'assemble']) then
    raise exception 'Job kinds must be a non-empty subset of prepare, image, video, assemble';
  end if;

  for v_lost in
    update public.cloud_lesson_jobs
    -- available_at is left as it was, so a recovered job keeps its place at
    -- the front of the queue instead of going behind work queued since.
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        worker_id = null, locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when attempts < max_attempts then null else now() end
    where status = 'processing'
      and coalesce(heartbeat_at, locked_at, started_at, created_at) < now() - interval '5 minutes'
    returning project_id, status
  loop
    if v_lost.status = 'failed' then
      perform private.fail_cloud_lesson(v_lost.project_id, 'A generation step stopped responding and ran out of retries.');
    end if;
  end loop;

  with candidate as (
    select j.id
    from public.cloud_lesson_jobs j
    join public.cloud_lesson_projects p on p.id = j.project_id
    where j.kind = any(p_kinds)
      and j.status = 'queued'
      and j.available_at <= now()
      and j.cancel_requested_at is null
      and j.attempts < j.max_attempts
      and p.status in ('preparing', 'generating_images', 'generating_videos', 'assembling')
    order by j.available_at, j.created_at
    for update of j skip locked
    limit 1
  )
  update public.cloud_lesson_jobs j
  set status = 'processing',
      progress = greatest(j.progress, 1),
      attempts = j.attempts + 1,
      worker_id = p_worker_id,
      locked_at = now(), heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()),
      error_code = null, error_message = null
  from candidate
  where j.id = candidate.id
  returning j.* into v_job;

  if v_job.id is null then return; end if;

  if v_job.kind in ('image', 'video') then
    update public.cloud_lesson_scenes
    set status = case v_job.kind when 'image' then 'generating_image' else 'generating_video' end
    where id = v_job.scene_id and status not in ('succeeded', 'failed', 'cancelled');
  end if;

  return next v_job;
end;
$$;

-- Records liveness and progress, and tells the worker whether to stop.
-- Returns 'ok', 'cancel' (the teacher cancelled; abandon the job) or 'lost'
-- (this worker no longer owns the job; stop without reporting).
create or replace function public.heartbeat_cloud_lesson_job(
  p_job_id uuid,
  p_worker_id text,
  p_progress smallint,
  p_provider_request_id text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.cloud_lesson_jobs;
begin
  update public.cloud_lesson_jobs
  set heartbeat_at = now(),
      progress = greatest(progress, least(99, greatest(0, coalesce(p_progress, 0)))),
      provider_request_id = coalesce(p_provider_request_id, provider_request_id)
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;
  if not found then return 'lost'; end if;
  return case when v_job.cancel_requested_at is null then 'ok' else 'cancel' end;
end;
$$;

-- Completes a prepare job: writes the plan, the narration and 8 scenes, then
-- queues the image jobs. Scene 1's image runs first; scenes 2-8 are held
-- (available_at = infinity) until it succeeds, because they use it as their
-- style reference — that is what makes eight pictures look like one lesson.
create or replace function public.complete_cloud_lesson_preparation(
  p_job_id uuid,
  p_worker_id text,
  p_title text,
  p_learning_objective text,
  p_narration_text text,
  p_narration_url text,
  p_narration_duration_seconds numeric,
  p_scenes jsonb,
  p_cost_usd numeric default 0,
  p_output_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The same house style and prompt framing as the RunPod engine, so the
  -- worker's prompt parsing (HOUSE_STYLE_MARKER, "Animate the subject
  -- physically:") applies unchanged to both.
  c_house_style constant text := 'Vintage editorial photograph with muted warm tones, soft diffused window light, gentle film grain, shallow depth of field, the subject centered and fully visible against a plain seamless warm-grey studio backdrop, generous empty space around it.';
  c_image_negative constant text := 'text, writing, letters, numbers, watermark, logo, distorted anatomy, duplicate subjects, low quality';
  v_job public.cloud_lesson_jobs;
  v_project public.cloud_lesson_projects;
  v_scene jsonb;
  v_scene_row public.cloud_lesson_scenes;
  v_index integer := 0;
  v_expected integer;
  v_duration numeric(6,3);
  v_fact text;
  v_narration text;
  v_caption text;
  v_overlay jsonb;
  v_visual text;
  v_motion text;
  v_mode text;
  v_image_prompt text;
  v_video_prompt text;
begin
  update public.cloud_lesson_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = 100, completed_at = now(), heartbeat_at = now(),
      cost_usd = greatest(coalesce(p_cost_usd, 0), 0),
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb)
  where id = p_job_id and worker_id = p_worker_id and status = 'processing' and kind = 'prepare'
  returning * into v_job;
  if not found then return false; end if;

  perform private.add_cloud_lesson_cost(v_job.project_id, 'prepare', p_cost_usd);

  select * into v_project from public.cloud_lesson_projects
  where id = v_job.project_id for update;
  if v_job.status = 'cancelled' or v_project.status <> 'preparing' then return true; end if;

  if char_length(btrim(coalesce(p_title, ''))) not between 3 and 200
     or char_length(btrim(coalesce(p_learning_objective, ''))) not between 10 and 500
     or char_length(btrim(coalesce(p_narration_text, ''))) not between 20 and 8000 then
    raise exception 'Invalid lesson content';
  end if;
  if p_narration_url is null or p_narration_url !~ '^https://' then
    raise exception 'Narration URL must use HTTPS';
  end if;
  if p_narration_duration_seconds is null
     or abs(p_narration_duration_seconds - v_project.target_duration_seconds) > 0.25 then
    raise exception 'Narration must be fitted to % seconds', v_project.target_duration_seconds;
  end if;

  v_expected := case v_project.target_duration_seconds when 60 then 8 else 12 end;
  if p_scenes is null or pg_catalog.jsonb_typeof(p_scenes) <> 'array'
     or pg_catalog.jsonb_array_length(p_scenes) <> v_expected then
    raise exception 'Expected % lesson scenes', v_expected;
  end if;
  v_duration := v_project.target_duration_seconds::numeric / v_expected;

  update public.cloud_lesson_projects
  set title = btrim(p_title),
      learning_objective = btrim(p_learning_objective),
      narration_text = btrim(p_narration_text),
      narration_url = p_narration_url,
      narration_duration_seconds = p_narration_duration_seconds,
      status = 'generating_images'
  where id = v_project.id;

  for v_scene in select value from pg_catalog.jsonb_array_elements(p_scenes)
  loop
    v_index := v_index + 1;
    if coalesce((v_scene ->> 'index')::integer, 0) <> v_index then
      raise exception 'Lesson scene indexes must be sequential';
    end if;
    v_fact := btrim(coalesce(v_scene ->> 'fact', ''));
    v_narration := btrim(coalesce(v_scene ->> 'narration', ''));
    v_caption := btrim(coalesce(v_scene ->> 'caption', ''));
    v_overlay := coalesce(v_scene -> 'overlay', '{"kind":"none"}'::jsonb);
    v_visual := btrim(coalesce(v_scene ->> 'visualDescription', ''));
    v_motion := btrim(coalesce(v_scene ->> 'motionDescription', ''));
    v_mode := coalesce(v_scene ->> 'motionMode', 'animate');
    if char_length(v_fact) not between 10 and 500
       or char_length(v_narration) not between 5 and 800
       or char_length(v_caption) > 120
       or char_length(v_visual) not between 20 and 1200
       or char_length(v_motion) not between 15 and 800
       or pg_catalog.jsonb_typeof(v_overlay) <> 'object'
       or coalesce(v_overlay ->> 'kind', '') not in ('none', 'arrow', 'equation', 'groups', 'bars', 'timeline')
       or v_mode not in ('animate', 'still') then
      raise exception 'Lesson scene % has invalid content', v_index;
    end if;

    v_image_prompt := pg_catalog.format('%s %s', v_visual, c_house_style);
    v_video_prompt := pg_catalog.format(
      '%s Animate the subject physically: %s Smooth, purposeful, physically plausible motion with stable object identity and a clear final state; the camera stays nearly still.',
      v_visual, v_motion
    );

    insert into public.cloud_lesson_scenes (
      project_id, scene_index, duration_seconds, fact, narration, caption, overlay,
      visual_description, motion_description, motion_mode, image_prompt, video_prompt
    ) values (
      v_project.id, v_index, v_duration, v_fact, v_narration, v_caption, v_overlay,
      v_visual, v_motion, v_mode, v_image_prompt, v_video_prompt
    ) returning * into v_scene_row;

    insert into public.cloud_lesson_jobs (
      owner_id, project_id, scene_id, kind, prompt, negative_prompt, max_attempts,
      available_at, parameters
    ) values (
      v_project.owner_id, v_project.id, v_scene_row.id, 'image', v_image_prompt, c_image_negative, 3,
      case when v_index = 1 then now() else 'infinity'::timestamptz end,
      pg_catalog.jsonb_build_object(
        'sceneIndex', v_index,
        'aspectRatio', '16:9',
        'awaitsStyleReference', v_index > 1
      )
    );
  end loop;

  return true;
end;
$$;

-- Completes an image, video or assemble job and advances the lesson.
--   image    → scene gets its keyframe and its video job is queued. Scene 1's
--              keyframe also releases scenes 2-8, carrying itself as their
--              style reference. All keyframes in → 'generating_videos'.
--   video    → scene clip stored. All clips in → assemble job queued.
--   assemble → the lesson is finished.
create or replace function public.complete_cloud_lesson_job(
  p_job_id uuid,
  p_worker_id text,
  p_output_url text,
  p_output_metadata jsonb default '{}'::jsonb,
  p_cost_usd numeric default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_video_negative constant text := 'text, writing, letters, numbers, captions, labels, logo, watermark, cuts, flicker, deformation, unstable geometry, frozen subject, static image, slideshow, camera-only motion';
  v_job public.cloud_lesson_jobs;
  v_project public.cloud_lesson_projects;
  v_scene public.cloud_lesson_scenes;
begin
  if p_output_url is null or p_output_url !~ '^https://' then
    raise exception 'Output URL must use HTTPS';
  end if;

  update public.cloud_lesson_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      cost_usd = greatest(coalesce(p_cost_usd, 0), 0),
      completed_at = now(), heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
    and kind in ('image', 'video', 'assemble')
  returning * into v_job;
  if not found then return false; end if;

  -- Money spent is money spent, cancelled or not.
  perform private.add_cloud_lesson_cost(v_job.project_id, v_job.kind, p_cost_usd);

  select * into v_project from public.cloud_lesson_projects
  where id = v_job.project_id for update;
  if v_job.status = 'cancelled' or v_project.status in ('cancelled', 'failed', 'succeeded') then
    return true;
  end if;

  if v_job.kind = 'image' then
    update public.cloud_lesson_scenes
    set image_url = p_output_url, status = 'queued_video', error_message = null
    where id = v_job.scene_id
    returning * into v_scene;

    insert into public.cloud_lesson_jobs (
      owner_id, project_id, scene_id, kind, prompt, negative_prompt,
      source_image_url, max_attempts, parameters
    ) values (
      v_project.owner_id, v_project.id, v_scene.id, 'video', v_scene.video_prompt, c_video_negative,
      p_output_url, 2,
      pg_catalog.jsonb_build_object(
        'sceneIndex', v_scene.scene_index,
        'motionMode', v_scene.motion_mode,
        'clipSeconds', 5,
        'slotSeconds', v_scene.duration_seconds
      )
    );

    if v_scene.scene_index = 1 then
      update public.cloud_lesson_jobs
      set available_at = now(),
          parameters = parameters
            || pg_catalog.jsonb_build_object('styleReferenceUrl', p_output_url, 'awaitsStyleReference', false)
      where project_id = v_project.id and kind = 'image' and status = 'queued'
        and available_at = 'infinity'::timestamptz;
    end if;

    if not exists (
      select 1 from public.cloud_lesson_scenes
      where project_id = v_project.id and image_url is null
    ) then
      update public.cloud_lesson_projects set status = 'generating_videos'
      where id = v_project.id and status = 'generating_images';
    end if;

  elsif v_job.kind = 'video' then
    update public.cloud_lesson_scenes
    set video_url = p_output_url, status = 'succeeded', error_message = null, completed_at = now()
    where id = v_job.scene_id;

    if not exists (
      select 1 from public.cloud_lesson_scenes
      where project_id = v_project.id and status <> 'succeeded'
    ) then
      insert into public.cloud_lesson_jobs (owner_id, project_id, kind, max_attempts, parameters)
      values (
        v_project.owner_id, v_project.id, 'assemble', 2,
        pg_catalog.jsonb_build_object('targetDurationSeconds', v_project.target_duration_seconds)
      ) on conflict (project_id) where kind = 'assemble' do nothing;
      update public.cloud_lesson_projects set status = 'assembling' where id = v_project.id;
    end if;

  else
    update public.cloud_lesson_projects
    set status = 'succeeded', final_video_url = p_output_url, error_message = null, completed_at = now()
    where id = v_project.id;
  end if;

  return true;
end;
$$;

-- Fails one attempt of a job. While attempts remain it goes back to the queue
-- after p_retry_delay_seconds; on the last attempt the scene and the lesson
-- fail and everything still queued for the lesson is cancelled.
create or replace function public.fail_cloud_lesson_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry_delay_seconds integer default 30,
  p_cost_usd numeric default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.cloud_lesson_jobs;
begin
  update public.cloud_lesson_jobs
  set status = case
        when cancel_requested_at is not null then 'cancelled'
        when attempts < max_attempts then 'queued'
        else 'failed' end,
      available_at = case
        when cancel_requested_at is null and attempts < max_attempts
          then now() + pg_catalog.make_interval(secs => greatest(1, coalesce(p_retry_delay_seconds, 30)))
        else available_at end,
      worker_id = null, locked_at = null, heartbeat_at = now(),
      cost_usd = cost_usd + greatest(coalesce(p_cost_usd, 0), 0),
      error_code = left(p_error_code, 100),
      error_message = left(p_error_message, 2000),
      completed_at = case
        when cancel_requested_at is not null or attempts >= max_attempts then now()
        else null end
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;
  if not found then return false; end if;

  perform private.add_cloud_lesson_cost(v_job.project_id, v_job.kind, p_cost_usd);

  if v_job.status = 'failed' then
    if v_job.scene_id is not null then
      update public.cloud_lesson_scenes
      set status = 'failed', error_message = left(p_error_message, 2000), completed_at = now()
      where id = v_job.scene_id;
    end if;
    perform private.fail_cloud_lesson(v_job.project_id, p_error_message);
  end if;
  return true;
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- New functions are executable by PUBLIC by default; take that away first.

revoke all on function public.reserve_cloud_lesson(smallint, text, text, text, smallint) from public, anon, authenticated, service_role;
revoke all on function public.cancel_cloud_lesson(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_cloud_lesson(smallint, text, text, text, smallint) to authenticated;
grant execute on function public.cancel_cloud_lesson(uuid) to authenticated;

revoke all on function public.claim_cloud_lesson_job(text, text[]) from public, anon, authenticated;
revoke all on function public.heartbeat_cloud_lesson_job(uuid, text, smallint, text) from public, anon, authenticated;
revoke all on function public.complete_cloud_lesson_preparation(uuid, text, text, text, text, text, numeric, jsonb, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.complete_cloud_lesson_job(uuid, text, text, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.fail_cloud_lesson_job(uuid, text, text, text, integer, numeric) from public, anon, authenticated;
grant execute on function public.claim_cloud_lesson_job(text, text[]) to service_role;
grant execute on function public.heartbeat_cloud_lesson_job(uuid, text, smallint, text) to service_role;
grant execute on function public.complete_cloud_lesson_preparation(uuid, text, text, text, text, text, numeric, jsonb, numeric, jsonb) to service_role;
grant execute on function public.complete_cloud_lesson_job(uuid, text, text, jsonb, numeric) to service_role;
grant execute on function public.fail_cloud_lesson_job(uuid, text, text, text, integer, numeric) to service_role;

-- ── Storage ──────────────────────────────────────────────────────────────────
-- Its own bucket, keyed `<project_id>/...`. Public so a lesson plays from a
-- plain URL (and Higgsfield can fetch a keyframe), but with NO select policy:
-- public-URL downloads do not consult RLS, while listing the bucket through the
-- API does — so without a select policy nobody can enumerate other schools'
-- lessons. Only the service-role workers write here; teachers never upload.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cloud-lesson-assets', 'cloud-lesson-assets', true, 524288000,
  array['audio/wav', 'audio/x-wav', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
