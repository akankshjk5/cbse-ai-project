-- Durable, narrated educational lessons. This schema is intentionally isolated
-- from the existing short video_projects/deck_media_jobs path so the proven
-- 3/5-second generator remains available while long lessons are validated.

create table public.lesson_video_projects (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  class_level smallint not null check (class_level between 1 and 12),
  subject text not null check (char_length(subject) between 2 and 100),
  topic text not null check (char_length(topic) between 3 and 300),
  language_code text not null check (language_code in (
    'en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'ta-IN', 'te-IN'
  )),
  language_name text not null check (char_length(language_name) between 2 and 50),
  target_duration_seconds smallint not null check (target_duration_seconds in (60, 90)),
  title text not null check (char_length(title) between 3 and 200),
  learning_objective text not null check (char_length(learning_objective) between 10 and 500),
  narration_text text not null check (char_length(narration_text) between 20 and 8000),
  narration_url text,
  narration_duration_seconds numeric(8,3),
  status text not null default 'generating_images' check (status in (
    'generating_images', 'generating_videos', 'assembling',
    'succeeded', 'failed', 'cancelled'
  )),
  final_video_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index lesson_video_projects_owner_created_idx
  on public.lesson_video_projects (owner_id, created_at desc);
create index lesson_video_projects_active_idx
  on public.lesson_video_projects (created_at)
  where status in ('generating_images', 'generating_videos', 'assembling');

create trigger lesson_video_projects_set_updated_at
  before update on public.lesson_video_projects
  for each row execute function public.set_updated_at();

create table public.lesson_video_scenes (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.lesson_video_projects (id) on delete cascade,
  scene_index smallint not null check (scene_index between 1 and 12),
  duration_seconds numeric(6,3) not null check (duration_seconds between 4 and 12),
  fact text not null check (char_length(fact) between 10 and 500),
  narration text not null check (char_length(narration) between 5 and 800),
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
  unique (project_id, scene_index)
);

create index lesson_video_scenes_project_idx
  on public.lesson_video_scenes (project_id, scene_index);

create trigger lesson_video_scenes_set_updated_at
  before update on public.lesson_video_scenes
  for each row execute function public.set_updated_at();

create table public.lesson_video_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  project_id uuid not null references public.lesson_video_projects (id) on delete cascade,
  scene_id uuid references public.lesson_video_scenes (id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'assemble')),
  profile text not null check (profile in ('image-fast', 'video-fast', 'lesson-assemble')),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'succeeded', 'failed', 'cancelled'
  )),
  prompt text not null default '' check (char_length(prompt) <= 4000),
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
  constraint lesson_video_jobs_shape_check check (
    (kind = 'image' and profile = 'image-fast' and scene_id is not null and source_image_url is null)
    or (kind = 'video' and profile = 'video-fast' and scene_id is not null and source_image_url is not null)
    or (kind = 'assemble' and profile = 'lesson-assemble' and scene_id is null)
  )
);

create index lesson_video_jobs_queue_idx
  on public.lesson_video_jobs (available_at, created_at) where status = 'queued';
create index lesson_video_jobs_project_idx
  on public.lesson_video_jobs (project_id, created_at);
create index lesson_video_jobs_scene_idx
  on public.lesson_video_jobs (scene_id, created_at) where scene_id is not null;
create unique index lesson_video_jobs_one_assembly_idx
  on public.lesson_video_jobs (project_id) where kind = 'assemble';

create trigger lesson_video_jobs_set_updated_at
  before update on public.lesson_video_jobs
  for each row execute function public.set_updated_at();

alter table public.lesson_video_projects enable row level security;
alter table public.lesson_video_scenes enable row level security;
alter table public.lesson_video_jobs enable row level security;

create or replace function public.is_lesson_video_project_owner(p_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.lesson_video_projects p
    where p.id = p_project_id and p.owner_id = public.clerk_user_id()
  );
$$;

revoke all on function public.is_lesson_video_project_owner(uuid) from public, anon;
grant execute on function public.is_lesson_video_project_owner(uuid) to authenticated, service_role;

create policy "lesson video projects: read own"
  on public.lesson_video_projects for select to authenticated
  using (owner_id = public.clerk_user_id());
create policy "lesson video scenes: read own"
  on public.lesson_video_scenes for select to authenticated
  using (public.is_lesson_video_project_owner(project_id));
create policy "lesson video jobs: read own"
  on public.lesson_video_jobs for select to authenticated
  using (owner_id = public.clerk_user_id() and public.is_lesson_video_project_owner(project_id));

revoke all on table public.lesson_video_projects from anon, authenticated;
revoke all on table public.lesson_video_scenes from anon, authenticated;
revoke all on table public.lesson_video_jobs from anon, authenticated;
grant select on table public.lesson_video_projects to authenticated;
grant select on table public.lesson_video_scenes to authenticated;
grant select on table public.lesson_video_jobs to authenticated;
grant select, insert, update, delete on table public.lesson_video_projects to service_role;
grant select, insert, update, delete on table public.lesson_video_scenes to service_role;
grant select, insert, update, delete on table public.lesson_video_jobs to service_role;

create or replace function public.create_lesson_video_project(
  p_class_level smallint,
  p_subject text,
  p_topic text,
  p_language_code text,
  p_language_name text,
  p_target_duration_seconds smallint,
  p_title text,
  p_learning_objective text,
  p_narration_text text,
  p_scenes jsonb
)
returns setof public.lesson_video_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := public.clerk_user_id();
  v_project public.lesson_video_projects;
  v_scene jsonb;
  v_scene_row public.lesson_video_scenes;
  v_index integer := 0;
  v_expected_count integer;
  v_scene_duration numeric(6,3);
  v_fact text;
  v_narration text;
  v_visual text;
  v_motion text;
  v_image_prompt text;
  v_video_prompt text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_class_level < 1 or p_class_level > 12 then raise exception 'Invalid class'; end if;
  if char_length(trim(p_subject)) not between 2 and 100 then raise exception 'Invalid subject'; end if;
  if char_length(trim(p_topic)) not between 3 and 300 then raise exception 'Invalid topic'; end if;
  if p_language_code not in ('en-IN','hi-IN','bn-IN','gu-IN','kn-IN','ml-IN','mr-IN','ta-IN','te-IN') then
    raise exception 'Unsupported narration language';
  end if;
  if p_target_duration_seconds not in (60, 90) then raise exception 'Duration must be 60 or 90 seconds'; end if;
  v_expected_count := case when p_target_duration_seconds = 60 then 8 else 12 end;
  if jsonb_typeof(p_scenes) <> 'array' or jsonb_array_length(p_scenes) <> v_expected_count then
    raise exception 'Expected % lesson scenes', v_expected_count;
  end if;
  v_scene_duration := p_target_duration_seconds::numeric / v_expected_count::numeric;

  insert into public.lesson_video_projects (
    owner_id, class_level, subject, topic, language_code, language_name,
    target_duration_seconds, title, learning_objective, narration_text
  ) values (
    v_owner, p_class_level, trim(p_subject), trim(p_topic), p_language_code,
    trim(p_language_name), p_target_duration_seconds, trim(p_title),
    trim(p_learning_objective), trim(p_narration_text)
  ) returning * into v_project;

  for v_scene in select value from jsonb_array_elements(p_scenes)
  loop
    v_index := v_index + 1;
    if coalesce((v_scene ->> 'index')::integer, 0) <> v_index then
      raise exception 'Lesson scene indexes must be sequential';
    end if;
    v_fact := trim(coalesce(v_scene ->> 'fact', ''));
    v_narration := trim(coalesce(v_scene ->> 'narration', ''));
    v_visual := trim(coalesce(v_scene ->> 'visualDescription', ''));
    v_motion := trim(coalesce(v_scene ->> 'motionDescription', ''));
    if char_length(v_fact) not between 10 and 500
       or char_length(v_narration) not between 5 and 800
       or char_length(v_visual) not between 20 and 1200
       or char_length(v_motion) not between 15 and 800 then
      raise exception 'Lesson scene % has invalid content lengths', v_index;
    end if;

    v_image_prompt := format(
      'Opening keyframe for a genuinely animated educational sequence for Class %s %s about %s. Scene %s of %s. Exact concept: %s. Visual composition: %s. Premium editorial motion-graphics composition with layered tactile objects, clear foreground and background separation, accurate physical relationships, and every object needed for the coming action already visible. One coherent widescreen 16:9 frame. No classroom, teacher, student audience, blackboard, projector, presentation slide, UI, source code, written equation, caption, label, logo, watermark, letters, numbers, or visible text.',
      p_class_level, trim(p_subject), trim(p_topic), v_index, v_expected_count, v_fact, v_visual
    );
    v_video_prompt := format(
      'Create a true animated explanation of this exact educational scene about %s, not a slideshow or moving photograph. Preserve object identity and the source composition, then execute every ordered action beat: %s. The subject action must visibly demonstrate the concept; camera movement is secondary. Use smooth purposeful motion, stable geometry, and a clear final state. No cuts, uncontrolled morphing, invented objects, classroom, teacher, captions, labels, logo, watermark, letters, numbers, or visible text.',
      trim(p_topic), v_motion
    );

    insert into public.lesson_video_scenes (
      project_id, scene_index, duration_seconds, fact, narration,
      image_prompt, video_prompt
    ) values (
      v_project.id, v_index, v_scene_duration, v_fact, v_narration,
      v_image_prompt, v_video_prompt
    ) returning * into v_scene_row;

    insert into public.lesson_video_jobs (
      owner_id, project_id, scene_id, kind, profile, prompt,
      negative_prompt, parameters
    ) values (
      v_owner, v_project.id, v_scene_row.id, 'image', 'image-fast', v_image_prompt,
      'text, writing, letters, numbers, captions, labels, classroom, teacher, blackboard, projector, watermark, logo, distorted anatomy, duplicate subjects, low quality, static slide, presentation card',
      jsonb_build_object('width', 1024, 'height', 576, 'steps', 8, 'sceneIndex', v_index)
    );
  end loop;

  return next v_project;
end;
$$;

create or replace function public.set_lesson_video_narration(
  p_project_id uuid,
  p_narration_url text,
  p_narration_duration_seconds numeric
)
returns setof public.lesson_video_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.lesson_video_projects;
begin
  if p_narration_url !~ '^https://' then raise exception 'Narration URL must use HTTPS'; end if;
  if p_narration_duration_seconds <= 1 or p_narration_duration_seconds > 90 then
    raise exception 'Narration duration is outside the supported range';
  end if;
  update public.lesson_video_projects
  set narration_url = p_narration_url,
      narration_duration_seconds = p_narration_duration_seconds
  where id = p_project_id
    and owner_id = public.clerk_user_id()
    and status in ('generating_images', 'generating_videos')
  returning * into v_project;
  if not found then raise exception 'Lesson project not found or not writable'; end if;

  if not exists (
    select 1 from public.lesson_video_scenes
    where project_id = p_project_id and status <> 'succeeded'
  ) then
    insert into public.lesson_video_jobs (
      owner_id, project_id, kind, profile, parameters
    ) values (
      v_project.owner_id, v_project.id, 'assemble', 'lesson-assemble',
      jsonb_build_object('targetDurationSeconds', v_project.target_duration_seconds)
    ) on conflict (project_id) where kind = 'assemble' do nothing;
    update public.lesson_video_projects set status = 'assembling' where id = p_project_id
    returning * into v_project;
  end if;
  return next v_project;
end;
$$;

create or replace function public.cancel_lesson_video_project(p_project_id uuid)
returns setof public.lesson_video_projects
language plpgsql
security definer
set search_path = public
as $$
declare v_project public.lesson_video_projects;
begin
  update public.lesson_video_projects
  set status = 'cancelled', completed_at = now(), error_message = null
  where id = p_project_id
    and owner_id = public.clerk_user_id()
    and status in ('generating_images', 'generating_videos', 'assembling')
  returning * into v_project;
  if not found then return; end if;

  update public.lesson_video_jobs
  set cancel_requested_at = now(),
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
  where project_id = p_project_id and status in ('queued', 'processing');
  update public.lesson_video_scenes
  set status = 'cancelled', completed_at = now()
  where project_id = p_project_id and status not in ('succeeded', 'failed', 'cancelled');
  return next v_project;
end;
$$;

create or replace function public.fail_lesson_video_setup(
  p_project_id uuid,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.lesson_video_projects
  set status = 'failed', error_message = left(p_error_message, 2000), completed_at = now()
  where id = p_project_id
    and owner_id = public.clerk_user_id()
    and narration_url is null
    and status in ('generating_images', 'generating_videos');
  get diagnostics changed = row_count;
  if changed = 1 then
    update public.lesson_video_jobs
    set cancel_requested_at = now(), status = case when status = 'queued' then 'cancelled' else status end,
        completed_at = case when status = 'queued' then now() else completed_at end
    where project_id = p_project_id and status in ('queued', 'processing');
  end if;
  return changed = 1;
end;
$$;

create or replace function public.claim_lesson_video_job(p_worker_id text)
returns setof public.lesson_video_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  with recovered as (
    update public.lesson_video_jobs
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        available_at = case when attempts < max_attempts then now() else available_at end,
        worker_id = null, locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when attempts >= max_attempts then now() else null end
    where status = 'processing'
      and coalesce(heartbeat_at, locked_at, started_at, created_at) < now() - interval '5 minutes'
    returning project_id, scene_id, status, error_message
  ), failed_projects as (
    update public.lesson_video_projects p
    set status = 'failed', error_message = r.error_message, completed_at = now()
    from recovered r where r.project_id = p.id and r.status = 'failed'
    returning p.id
  )
  update public.lesson_video_jobs j
  set status = 'cancelled', cancel_requested_at = now(), completed_at = now()
  from failed_projects p
  where j.project_id = p.id and j.status = 'queued';

  return query
  with candidate as (
    select id from public.lesson_video_jobs
    where status = 'queued' and available_at <= now()
      and cancel_requested_at is null and attempts < max_attempts
    order by created_at
    for update skip locked limit 1
  )
  update public.lesson_video_jobs j
  set status = 'processing', progress = greatest(j.progress, 1),
      attempts = j.attempts + 1, worker_id = p_worker_id,
      locked_at = now(), heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()), error_code = null, error_message = null
  from candidate where j.id = candidate.id
  returning j.*;

  update public.lesson_video_scenes s
  set status = case j.kind when 'image' then 'generating_image' else 'generating_video' end
  from public.lesson_video_jobs j
  where j.scene_id = s.id and j.worker_id = p_worker_id
    and j.status = 'processing' and j.kind in ('image', 'video');
end;
$$;

create or replace function public.heartbeat_lesson_video_job(
  p_job_id uuid, p_worker_id text, p_progress smallint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.lesson_video_jobs
  set heartbeat_at = now(), progress = greatest(progress, least(99, p_progress))
  where id = p_job_id and worker_id = p_worker_id and status = 'processing';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.complete_lesson_video_job(
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
declare
  v_job public.lesson_video_jobs;
  v_project public.lesson_video_projects;
  v_scene public.lesson_video_scenes;
begin
  update public.lesson_video_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      completed_at = now(), heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;
  if not found then return false; end if;

  select * into v_project from public.lesson_video_projects
  where id = v_job.project_id for update;
  if v_job.status = 'cancelled' or v_project.status = 'cancelled' then return true; end if;

  if v_job.kind = 'image' then
    update public.lesson_video_scenes
    set image_url = p_output_url, status = 'queued_video', error_message = null
    where id = v_job.scene_id returning * into v_scene;
    insert into public.lesson_video_jobs (
      owner_id, project_id, scene_id, kind, profile, prompt,
      negative_prompt, source_image_url, parameters
    ) values (
      v_project.owner_id, v_project.id, v_scene.id, 'video', 'video-fast', v_scene.video_prompt,
      'text, writing, letters, numbers, captions, labels, logo, watermark, cuts, flicker, deformation, unstable geometry, frozen subject, static image, slideshow, camera-only motion',
      p_output_url,
      jsonb_build_object('width', 832, 'height', 480, 'durationSeconds', 5, 'fps', 16, 'steps', 20, 'sceneIndex', v_scene.scene_index)
    );
    if not exists (
      select 1 from public.lesson_video_scenes
      where project_id = v_project.id and image_url is null
    ) then
      update public.lesson_video_projects set status = 'generating_videos' where id = v_project.id;
    end if;
  elsif v_job.kind = 'video' then
    update public.lesson_video_scenes
    set video_url = p_output_url, status = 'succeeded', error_message = null, completed_at = now()
    where id = v_job.scene_id;
    if not exists (
      select 1 from public.lesson_video_scenes
      where project_id = v_project.id and status <> 'succeeded'
    ) and v_project.narration_url is not null then
      insert into public.lesson_video_jobs (
        owner_id, project_id, kind, profile, parameters
      ) values (
        v_project.owner_id, v_project.id, 'assemble', 'lesson-assemble',
        jsonb_build_object('targetDurationSeconds', v_project.target_duration_seconds)
      ) on conflict (project_id) where kind = 'assemble' do nothing;
      update public.lesson_video_projects set status = 'assembling' where id = v_project.id;
    end if;
  else
    update public.lesson_video_projects
    set status = 'succeeded', final_video_url = p_output_url,
        error_message = null, completed_at = now()
    where id = v_project.id;
  end if;
  return true;
end;
$$;

create or replace function public.fail_lesson_video_job(
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
declare v_job public.lesson_video_jobs;
begin
  update public.lesson_video_jobs
  set status = case
        when cancel_requested_at is not null then 'cancelled'
        when attempts < max_attempts then 'queued' else 'failed' end,
      available_at = case
        when cancel_requested_at is null and attempts < max_attempts
          then now() + make_interval(secs => greatest(1, p_retry_delay_seconds))
        else available_at end,
      worker_id = null, locked_at = null, heartbeat_at = now(),
      error_code = left(p_error_code, 100), error_message = left(p_error_message, 2000),
      completed_at = case when cancel_requested_at is not null or attempts >= max_attempts then now() else null end
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;
  if not found then return false; end if;

  if v_job.status in ('failed', 'cancelled') then
    if v_job.scene_id is not null then
      update public.lesson_video_scenes
      set status = v_job.status, error_message = left(p_error_message, 2000), completed_at = now()
      where id = v_job.scene_id;
    end if;
    update public.lesson_video_projects
    set status = v_job.status, error_message = left(p_error_message, 2000), completed_at = now()
    where id = v_job.project_id;
    update public.lesson_video_jobs
    set status = 'cancelled', cancel_requested_at = now(), completed_at = now()
    where project_id = v_job.project_id and status = 'queued';
  end if;
  return true;
end;
$$;

revoke all on function public.create_lesson_video_project(smallint,text,text,text,text,smallint,text,text,text,jsonb) from public, anon;
revoke all on function public.set_lesson_video_narration(uuid,text,numeric) from public, anon;
revoke all on function public.cancel_lesson_video_project(uuid) from public, anon;
revoke all on function public.fail_lesson_video_setup(uuid,text) from public, anon;
grant execute on function public.create_lesson_video_project(smallint,text,text,text,text,smallint,text,text,text,jsonb) to authenticated;
grant execute on function public.set_lesson_video_narration(uuid,text,numeric) to authenticated;
grant execute on function public.cancel_lesson_video_project(uuid) to authenticated;
grant execute on function public.fail_lesson_video_setup(uuid,text) to authenticated;

revoke all on function public.claim_lesson_video_job(text) from public, anon, authenticated;
revoke all on function public.heartbeat_lesson_video_job(uuid,text,smallint) from public, anon, authenticated;
revoke all on function public.complete_lesson_video_job(uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.fail_lesson_video_job(uuid,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.claim_lesson_video_job(text) to service_role;
grant execute on function public.heartbeat_lesson_video_job(uuid,text,smallint) to service_role;
grant execute on function public.complete_lesson_video_job(uuid,text,text,jsonb) to service_role;
grant execute on function public.fail_lesson_video_job(uuid,text,text,text,integer) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lesson-video-assets', 'lesson-video-assets', true, 524288000,
  array['audio/wav', 'audio/x-wav', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.is_lesson_video_asset_owner(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, storage
as $$
declare v_project_id uuid;
begin
  v_project_id := split_part(p_name, '/', 1)::uuid;
  return public.is_lesson_video_project_owner(v_project_id);
exception when invalid_text_representation then
  return false;
end;
$$;

revoke all on function public.is_lesson_video_asset_owner(text) from public, anon;
grant execute on function public.is_lesson_video_asset_owner(text) to authenticated, service_role;

create policy "lesson-video-assets: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'lesson-video-assets');
create policy "lesson-video-assets: owner narration insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'lesson-video-assets'
    and public.is_lesson_video_asset_owner(name)
    and name ~ '^[0-9a-f-]+/narration[.]wav$'
  );
