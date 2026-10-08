-- Standalone educational video projects.
--
-- A user submits class, subject and topic once. Postgres creates the image job;
-- completing that image atomically queues the Wan image-to-video job. The
-- chain therefore survives navigation, browser closure and Next.js restarts.

create table public.video_projects (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id text not null,
  class_level smallint not null check (class_level between 1 and 12),
  subject text not null check (char_length(subject) between 2 and 100),
  topic text not null check (char_length(topic) between 3 and 300),
  image_prompt text not null check (char_length(image_prompt) between 3 and 4000),
  video_prompt text not null check (char_length(video_prompt) between 3 and 4000),
  status text not null default 'generating_image'
    check (status in (
      'generating_image', 'generating_video', 'succeeded', 'failed', 'cancelled'
    )),
  image_job_id uuid,
  video_job_id uuid,
  image_url text,
  video_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index video_projects_owner_created_idx
  on public.video_projects (owner_id, created_at desc);
create index video_projects_active_idx
  on public.video_projects (owner_id, created_at)
  where status in ('generating_image', 'generating_video');

create trigger video_projects_set_updated_at
  before update on public.video_projects
  for each row execute function public.set_updated_at();

alter table public.video_projects enable row level security;

create policy "video projects: read own"
  on public.video_projects for select to authenticated
  using (owner_id = public.clerk_user_id());

revoke all on table public.video_projects from anon, authenticated;
grant select on table public.video_projects to authenticated;
grant select, insert, update, delete on table public.video_projects to service_role;

create or replace function public.is_video_project_owner(p_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.video_projects p
    where p.id = p_project_id
      and p.owner_id = public.clerk_user_id()
  );
$$;

revoke all on function public.is_video_project_owner(uuid) from public, anon;
grant execute on function public.is_video_project_owner(uuid) to authenticated, service_role;

alter table public.deck_media_jobs
  alter column deck_id drop not null,
  add column video_project_id uuid references public.video_projects (id) on delete cascade;

alter table public.deck_media_jobs
  add constraint deck_media_jobs_exactly_one_parent check (
    (deck_id is not null and video_project_id is null)
    or (deck_id is null and video_project_id is not null)
  ),
  add constraint deck_media_jobs_slide_requires_deck check (
    slide_id is null or deck_id is not null
  );

create index deck_media_jobs_video_project_idx
  on public.deck_media_jobs (video_project_id, created_at)
  where video_project_id is not null;

alter table public.video_projects
  add constraint video_projects_image_job_fkey
    foreign key (image_job_id) references public.deck_media_jobs (id) on delete set null,
  add constraint video_projects_video_job_fkey
    foreign key (video_job_id) references public.deck_media_jobs (id) on delete set null;

drop policy if exists "deck media jobs: read own" on public.deck_media_jobs;
drop policy if exists "deck media jobs: create own" on public.deck_media_jobs;

create policy "deck media jobs: read own"
  on public.deck_media_jobs for select to authenticated
  using (
    owner_id = public.clerk_user_id()
    and (
      (deck_id is not null and public.is_deck_owner(deck_id))
      or (
        video_project_id is not null
        and public.is_video_project_owner(video_project_id)
      )
    )
  );

create policy "deck media jobs: create own"
  on public.deck_media_jobs for insert to authenticated
  with check (
    owner_id = public.clerk_user_id()
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
      (
        deck_id is not null
        and video_project_id is null
        and public.is_deck_owner(deck_id)
        and (
          slide_id is null
          or exists (
            select 1 from public.slides s
            where s.id = slide_id and s.deck_id = deck_media_jobs.deck_id
          )
        )
      )
      or (
        deck_id is null
        and slide_id is null
        and target_block is null
        and video_project_id is not null
        and public.is_video_project_owner(video_project_id)
      )
    )
  );

create or replace function public.create_video_project(
  p_class_level smallint,
  p_subject text,
  p_topic text
)
returns setof public.video_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := public.clerk_user_id();
  v_project public.video_projects;
  v_job_id uuid;
  v_subject text := trim(p_subject);
  v_topic text := trim(p_topic);
  v_image_prompt text;
  v_video_prompt text;
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  if p_class_level < 1 or p_class_level > 12 then
    raise exception 'Class must be between 1 and 12';
  end if;
  if char_length(v_subject) < 2 or char_length(v_subject) > 100 then
    raise exception 'Subject must be between 2 and 100 characters';
  end if;
  if char_length(v_topic) < 3 or char_length(v_topic) > 300 then
    raise exception 'Topic must be between 3 and 300 characters';
  end if;

  v_image_prompt := format(
    'Cinematic educational illustration for Class %s %s about %s. One clear central subject, accurate visual details, engaging classroom-friendly composition, rich natural lighting, widescreen 16:9, no labels, no text, no watermark.',
    p_class_level, v_subject, v_topic
  );
  v_video_prompt := format(
    'Create smooth cinematic educational motion illustrating %s for Class %s %s. Preserve the exact subject and composition of the source image. Use a gentle camera push and subtle natural movement, stable geometry, no cuts, no added text, no watermark.',
    v_topic, p_class_level, v_subject
  );

  insert into public.video_projects (
    owner_id, class_level, subject, topic, image_prompt, video_prompt
  ) values (
    v_owner, p_class_level, v_subject, v_topic, v_image_prompt, v_video_prompt
  ) returning * into v_project;

  insert into public.deck_media_jobs (
    owner_id, video_project_id, kind, profile, prompt, negative_prompt, parameters
  ) values (
    v_owner,
    v_project.id,
    'image',
    'image-fast',
    v_image_prompt,
    'text, captions, watermark, logo, distorted anatomy, duplicate subjects, low quality',
    jsonb_build_object('width', 1024, 'height', 576, 'steps', 8)
  ) returning id into v_job_id;

  update public.video_projects
  set image_job_id = v_job_id
  where id = v_project.id
  returning * into v_project;

  return next v_project;
end;
$$;

revoke all on function public.create_video_project(smallint, text, text) from public, anon;
grant execute on function public.create_video_project(smallint, text, text) to authenticated;

-- Completing the image stage queues the video stage in the same transaction.
-- Completing the video stage publishes the standalone project result.
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
declare
  v_job public.deck_media_jobs;
  v_project public.video_projects;
  v_video_job_id uuid;
begin
  update public.deck_media_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      completed_at = now(),
      heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;

  if not found then return false; end if;
  if v_job.video_project_id is null then return true; end if;

  select * into v_project
  from public.video_projects
  where id = v_job.video_project_id
  for update;

  if v_job.status = 'cancelled' then
    update public.video_projects
    set status = 'cancelled', completed_at = now()
    where id = v_project.id;
    return true;
  end if;

  if v_job.kind = 'image' then
    insert into public.deck_media_jobs (
      owner_id, video_project_id, kind, profile, prompt, negative_prompt,
      source_image_url, parameters
    ) values (
      v_project.owner_id,
      v_project.id,
      'video',
      'video-fast',
      v_project.video_prompt,
      'text, captions, watermark, logo, scene cuts, flicker, deformation, unstable subject',
      p_output_url,
      jsonb_build_object(
        'width', 832, 'height', 480, 'durationSeconds', 3, 'fps', 16, 'steps', 20
      )
    ) returning id into v_video_job_id;

    update public.video_projects
    set status = 'generating_video',
        image_url = p_output_url,
        video_job_id = v_video_job_id,
        error_message = null
    where id = v_project.id;
  else
    update public.video_projects
    set status = 'succeeded',
        video_url = p_output_url,
        error_message = null,
        completed_at = now()
    where id = v_project.id;
  end if;

  return true;
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
declare
  v_job public.deck_media_jobs;
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
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;

  if not found then return false; end if;
  if v_job.video_project_id is not null and v_job.status in ('failed', 'cancelled') then
    update public.video_projects
    set status = v_job.status,
        error_message = left(p_error_message, 2000),
        completed_at = now()
    where id = v_job.video_project_id;
  end if;
  return true;
end;
$$;

create or replace function public.request_deck_media_job_cancel(p_job_id uuid)
returns setof public.deck_media_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.deck_media_jobs;
begin
  update public.deck_media_jobs
  set cancel_requested_at = now(),
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
  where id = p_job_id
    and owner_id = public.clerk_user_id()
    and (
      (deck_id is not null and public.is_deck_owner(deck_id))
      or (
        video_project_id is not null
        and public.is_video_project_owner(video_project_id)
      )
    )
    and status in ('queued', 'processing')
  returning * into v_job;

  if not found then return; end if;
  if v_job.video_project_id is not null and v_job.status = 'cancelled' then
    update public.video_projects
    set status = 'cancelled', completed_at = now()
    where id = v_job.video_project_id;
  end if;
  return next v_job;
end;
$$;

create or replace function public.retry_deck_media_job(p_job_id uuid)
returns setof public.deck_media_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.deck_media_jobs;
begin
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
    and (
      (deck_id is not null and public.is_deck_owner(deck_id))
      or (
        video_project_id is not null
        and public.is_video_project_owner(video_project_id)
      )
    )
    and status = 'failed'
  returning * into v_job;

  if not found then return; end if;
  if v_job.video_project_id is not null then
    update public.video_projects
    set status = case when v_job.kind = 'image' then 'generating_image' else 'generating_video' end,
        error_message = null,
        completed_at = null
    where id = v_job.video_project_id;
  end if;
  return next v_job;
end;
$$;

-- Standalone video outputs do not belong to a deck, so they use a dedicated
-- service-role-written public bucket. Browsers can read final outputs but have
-- no direct write policy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'video-assets',
  'video-assets',
  true,
  104857600,
  array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "video-assets: public read" on storage.objects;
create policy "video-assets: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'video-assets');
