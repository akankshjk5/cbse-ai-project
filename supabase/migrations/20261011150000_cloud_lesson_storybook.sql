-- Cloud lessons: a third visual style, `storybook` — pen-and-ink engraving on
-- aged paper, told in 2-3 shots per scene with a chapter title.
--
-- Cloud engine only. The RunPod lesson tables and the deck tables are not
-- touched, and the two existing cloud styles behave exactly as before: every
-- function replaced here hands any non-storybook work to the previous version
-- unchanged.
--
-- What it adds:
--   * 'storybook' as a visual_style.
--   * cloud_lesson_scenes.title — a 2-60 character chapter title (storybook).
--   * cloud_lesson_shots — 2 or 3 shots per storybook scene, each with its own
--     picture, shot size and camera move.
--   * cloud_lesson_jobs.shot_id — a storybook image job makes one shot.
-- Shot 1 of scene 1 is generated first and is the style reference for every
-- other shot, the same rule the existing styles apply per scene.

-- ── Columns and tables ───────────────────────────────────────────────────────

alter table public.cloud_lesson_projects drop constraint cloud_lesson_projects_visual_style_check;
alter table public.cloud_lesson_projects add constraint cloud_lesson_projects_visual_style_check
  check (visual_style in ('editorial', 'illustrated', 'storybook'));

alter table public.cloud_lesson_scenes
  add column title text check (title is null or char_length(title) between 2 and 60);

create table public.cloud_lesson_shots (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  scene_id uuid not null references public.cloud_lesson_scenes (id) on delete cascade,
  shot_index smallint not null check (shot_index between 1 and 3),
  shot_size text not null check (shot_size in ('wide', 'medium', 'close', 'detail')),
  camera_move text not null default 'push_in'
    check (camera_move in ('push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down')),
  visual_description text not null check (char_length(visual_description) between 20 and 1200),
  image_prompt text not null check (char_length(image_prompt) between 20 and 4000),
  status text not null default 'queued' check (status in ('queued', 'succeeded', 'failed', 'cancelled')),
  image_url text check (image_url is null or image_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (scene_id, shot_index)  -- also serves as the scene_id FK index
);
create index cloud_lesson_shots_project_idx on public.cloud_lesson_shots (project_id);

create trigger cloud_lesson_shots_set_updated_at
  before update on public.cloud_lesson_shots
  for each row execute function public.set_updated_at();

alter table public.cloud_lesson_shots enable row level security;
create policy "cloud lesson shots: read own"
  on public.cloud_lesson_shots for select to authenticated
  using (exists (
    select 1 from public.cloud_lesson_projects p
    where p.id = project_id and p.owner_id = (select public.clerk_user_id())
  ));
revoke all on table public.cloud_lesson_shots from public, anon, authenticated;
grant select on table public.cloud_lesson_shots to authenticated;
grant select, insert, update, delete on table public.cloud_lesson_shots to service_role;

alter table public.cloud_lesson_jobs
  add column shot_id uuid references public.cloud_lesson_shots (id) on delete cascade;
alter table public.cloud_lesson_jobs add constraint cloud_lesson_jobs_shot_kind_check
  check (shot_id is null or kind = 'image');
create index cloud_lesson_jobs_shot_idx on public.cloud_lesson_jobs (shot_id) where shot_id is not null;

-- ── Style constants ──────────────────────────────────────────────────────────

create function private.cloud_lesson_storybook_style() returns text
language sql immutable set search_path = '' as $$
  select 'Black-and-white pen-and-ink engraving illustration in the manner of a nineteenth-century book plate: fine cross-hatching and stippled shading, crisp confident linework, strong contrast, printed on aged cream sepia paper with a soft vignette. A full-bleed scene that fills the whole frame with one clear focal point. No text, letters, numbers, captions, banners, labels or watermark.'::text
$$;

create function private.cloud_lesson_storybook_negative() returns text
language sql immutable set search_path = '' as $$
  select 'text, writing, letters, numbers, captions, banners, labels, watermark, logo, colour, color photograph, photorealistic, 3D render, flat vector cartoon, distorted anatomy, extra fingers, duplicate subjects, low quality'::text
$$;

-- Animated scenes a storybook lesson may pay Higgsfield for: 3 of 8, 2 of 4.
create function private.cloud_lesson_storybook_animation_cap(p_scene_count integer) returns integer
language sql immutable set search_path = '' as $$
  select case when p_scene_count <= 4 then 2 else 3 end
$$;

revoke all on function private.cloud_lesson_storybook_style() from public, anon, authenticated;
revoke all on function private.cloud_lesson_storybook_negative() from public, anon, authenticated;
revoke all on function private.cloud_lesson_storybook_animation_cap(integer) from public, anon, authenticated;

-- ── Reservation: accept the new style ────────────────────────────────────────
-- Same body as 20261011120000 except the style list.

create or replace function public.reserve_cloud_lesson(
 p_class_level smallint,p_subject text,p_topic text,p_language_code text,p_target_duration_seconds smallint default 60,p_visual_style text default 'illustrated'
) returns setof public.cloud_lesson_projects language plpgsql security definer set search_path='' as $$
declare
 v_owner text := public.clerk_user_id(); v_key text;
 v_project public.cloud_lesson_projects; v_source public.cloud_lesson_projects;
begin
 if v_owner is null then raise exception 'Sign in to generate a lesson.' using hint='cloud_lesson_auth'; end if;
 if p_class_level is null or p_class_level not between 1 and 12
 or char_length(btrim(coalesce(p_subject,''))) not between 2 and 100
 or char_length(btrim(coalesce(p_topic,''))) not between 3 and 300
 or p_language_code is null or p_language_code not in ('en-IN','hi-IN','kn-IN')
 or p_target_duration_seconds is null or p_target_duration_seconds not in (30,60)
 or p_visual_style is null or p_visual_style not in ('illustrated','editorial','storybook') then
   raise exception 'Check the class, subject, topic and language.' using hint='cloud_lesson_invalid';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cloud_lesson_reserve:'||v_owner,0));
 v_key := p_class_level::text||'|'||lower(regexp_replace(btrim(p_subject),'\s+',' ','g'))
   ||'|'||lower(regexp_replace(btrim(p_topic),'\s+',' ','g'))||'|'||p_target_duration_seconds::text;
 -- Exact completed hits and repeated clicks on active work require no new job.
 select * into v_project from public.cloud_lesson_projects
 where owner_id=v_owner and content_key=v_key and visual_style=p_visual_style and language_code=p_language_code
 and status in ('succeeded','preparing','generating_images','generating_videos','assembling')
 order by (status='succeeded') desc,created_at desc limit 1;
 if found then return next v_project; return; end if;

 -- Only audited source plans with every scene ready can be reused.
 select p.* into v_source from public.cloud_lesson_projects p
 where p.owner_id=v_owner and p.content_key=v_key and p.visual_style=p_visual_style and p.status='succeeded' and p.reused_from_project_id is null
 and exists(select 1 from public.cloud_lesson_jobs j where j.project_id=p.id and j.kind='prepare'
   and j.status='succeeded' and jsonb_typeof(j.output_metadata->'sourcePlan')='object')
 and (select count(*) from public.cloud_lesson_scenes s where s.project_id=p.id and s.status='succeeded' and s.image_url is not null)=p_target_duration_seconds/7.5
 and not exists(select 1 from public.cloud_lesson_scenes s where s.project_id=p.id and s.motion_mode='animate'
   and not exists(select 1 from public.cloud_lesson_jobs j where j.scene_id=s.id and j.kind='video' and j.status='succeeded'
     and coalesce(j.output_metadata->>'rawVideoUrl','') ~ '^https://'))
 -- A storybook source must also have every shot's picture.
 and not exists(select 1 from public.cloud_lesson_shots t where t.project_id=p.id and t.image_url is null)
 order by p.completed_at desc limit 1;
 select * into v_project from private.reserve_cloud_lesson_uncached(
   p_class_level,p_subject,p_topic,p_language_code,p_target_duration_seconds);
 update public.cloud_lesson_projects set visual_style=p_visual_style where id=v_project.id returning * into v_project;
 update public.cloud_lesson_jobs set parameters=parameters||jsonb_build_object('visualStyle',p_visual_style) where project_id=v_project.id and kind='prepare';
 if v_source.id is not null then
   update public.cloud_lesson_projects set reused_from_project_id=v_source.id where id=v_project.id returning * into v_project;
 end if;
 return next v_project;
end; $$;
revoke all on function public.reserve_cloud_lesson(smallint,text,text,text,smallint,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_cloud_lesson(smallint,text,text,text,smallint,text) to authenticated;

-- ── Preparation: storybook scenes carry a title and 2-3 shots ───────────────
-- The scene list a prep worker sends gains, for storybook only:
--   "title": "The Grand Bazaar",
--   "shots": [{"shotSize":"wide","cameraMove":"push_in","visualDescription":"..."}, ...]
-- with the scene's visualDescription equal to shot 1's. Every existing check
-- still runs (in complete_cloud_lesson_preparation_original); the storybook
-- checks run first, in the same transaction, so a bad plan writes nothing.

create or replace function public.complete_cloud_lesson_preparation(
 p_job_id uuid,p_worker_id text,p_title text,p_learning_objective text,p_narration_text text,
 p_narration_url text,p_narration_duration_seconds numeric,p_scenes jsonb,p_cost_usd numeric default 0,
 p_output_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare
 v_ok boolean; v_project public.cloud_lesson_projects; v_scene record; v_raw text;
 v_style text; v_scene_json jsonb; v_shot jsonb; v_shot_index integer; v_animated integer := 0;
 v_scene_row public.cloud_lesson_scenes; v_shot_row public.cloud_lesson_shots;
 v_title text; v_visual text; v_image_prompt text; v_scene_count integer;
begin
 select p.visual_style, p.target_duration_seconds / 7.5 into v_style, v_scene_count
 from public.cloud_lesson_jobs j join public.cloud_lesson_projects p on p.id = j.project_id
 where j.id = p_job_id and j.worker_id = p_worker_id and j.status = 'processing' and j.kind = 'prepare';

 if p_scenes is not null and pg_catalog.jsonb_typeof(p_scenes) = 'array' then
   for v_scene_json in select value from pg_catalog.jsonb_array_elements(p_scenes) loop
     if v_style is distinct from 'storybook' then
       if v_scene_json ? 'shots' then raise exception 'Shots are only for storybook lessons'; end if;
       continue;
     end if;
     v_title := btrim(coalesce(v_scene_json ->> 'title', ''));
     if char_length(v_title) not between 2 and 60 then
       raise exception 'Storybook scene % needs a 2-60 character title', v_scene_json ->> 'index';
     end if;
     if pg_catalog.jsonb_typeof(v_scene_json -> 'shots') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_scene_json -> 'shots') not between 2 and 3 then
       raise exception 'Storybook scene % needs 2 or 3 shots', v_scene_json ->> 'index';
     end if;
     for v_shot in select value from pg_catalog.jsonb_array_elements(v_scene_json -> 'shots') loop
       if coalesce(v_shot ->> 'shotSize', '') not in ('wide', 'medium', 'close', 'detail')
          or coalesce(v_shot ->> 'cameraMove', 'push_in') not in ('push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down')
          or char_length(btrim(coalesce(v_shot ->> 'visualDescription', ''))) not between 20 and 1200 then
         raise exception 'Storybook scene % has an invalid shot', v_scene_json ->> 'index';
       end if;
     end loop;
     if btrim(coalesce(v_scene_json ->> 'visualDescription', ''))
        <> btrim(coalesce(v_scene_json -> 'shots' -> 0 ->> 'visualDescription', '')) then
       raise exception 'Storybook scene % must describe its first shot as its visual', v_scene_json ->> 'index';
     end if;
     if v_scene_json ->> 'motionMode' = 'animate' then
       v_animated := v_animated + 1;
       if v_animated > private.cloud_lesson_storybook_animation_cap(v_scene_count) then
         raise exception 'Too many animated scenes';
       end if;
     end if;
   end loop;
 end if;

 v_ok := private.complete_cloud_lesson_preparation_original(p_job_id,p_worker_id,p_title,p_learning_objective,
   p_narration_text,p_narration_url,p_narration_duration_seconds,p_scenes,p_cost_usd,p_output_metadata);
 if not v_ok then return false; end if;
 select p.* into v_project from public.cloud_lesson_projects p join public.cloud_lesson_jobs j on j.project_id=p.id where j.id=p_job_id;
 if v_project.status <> 'generating_images' then return true; end if;

 -- Storybook: replace the one-image-per-scene jobs with one job per shot, and
 -- the house-style prompts with the engraving style.
 if v_project.visual_style = 'storybook' then
   delete from public.cloud_lesson_jobs
   where project_id = v_project.id and kind = 'image' and status = 'queued' and shot_id is null;
   for v_scene_json in select value from pg_catalog.jsonb_array_elements(p_scenes) loop
     select * into v_scene_row from public.cloud_lesson_scenes
     where project_id = v_project.id and scene_index = (v_scene_json ->> 'index')::smallint;
     v_visual := btrim(v_scene_json -> 'shots' -> 0 ->> 'visualDescription');
     v_image_prompt := pg_catalog.format('%s %s', v_visual, private.cloud_lesson_storybook_style());
     update public.cloud_lesson_scenes
     set title = btrim(v_scene_json ->> 'title'),
         image_prompt = v_image_prompt,
         video_prompt = pg_catalog.format(
           '%s Animate the scene physically: %s Keep the pen-and-ink engraving look, the same paper texture and the same linework in every frame; smooth, purposeful, physically plausible motion with stable identities; the camera stays nearly still.',
           v_image_prompt, btrim(v_scene_json ->> 'motionDescription'))
     where id = v_scene_row.id;
     v_shot_index := 0;
     for v_shot in select value from pg_catalog.jsonb_array_elements(v_scene_json -> 'shots') loop
       v_shot_index := v_shot_index + 1;
       insert into public.cloud_lesson_shots (
         project_id, scene_id, shot_index, shot_size, camera_move, visual_description, image_prompt
       ) values (
         v_project.id, v_scene_row.id, v_shot_index, v_shot ->> 'shotSize',
         coalesce(v_shot ->> 'cameraMove', 'push_in'), btrim(v_shot ->> 'visualDescription'),
         pg_catalog.format('%s %s', btrim(v_shot ->> 'visualDescription'), private.cloud_lesson_storybook_style())
       ) returning * into v_shot_row;
       insert into public.cloud_lesson_jobs (
         owner_id, project_id, scene_id, shot_id, kind, prompt, negative_prompt, max_attempts, available_at, parameters
       ) values (
         v_project.owner_id, v_project.id, v_scene_row.id, v_shot_row.id, 'image', v_shot_row.image_prompt,
         private.cloud_lesson_storybook_negative(), 3,
         case when v_scene_row.scene_index = 1 and v_shot_index = 1 then now() else 'infinity'::timestamptz end,
         pg_catalog.jsonb_build_object(
           'sceneIndex', v_scene_row.scene_index,
           'shotIndex', v_shot_index,
           'shotSize', v_shot_row.shot_size,
           'aspectRatio', '16:9',
           'visualStyle', 'storybook',
           'awaitsStyleReference', not (v_scene_row.scene_index = 1 and v_shot_index = 1)
         )
       );
     end loop;
   end loop;
 end if;

 if v_project.reused_from_project_id is null then return true; end if;

 -- Reuse (unchanged from 20261011120000, plus storybook shots).
 if not exists(select 1 from public.cloud_lesson_projects p where p.id=v_project.reused_from_project_id
   and p.owner_id=v_project.owner_id and p.status='succeeded' and p.content_key=v_project.content_key and p.visual_style=v_project.visual_style) then
   raise exception 'Visual reuse source is unavailable';
 end if;
 delete from public.cloud_lesson_jobs where project_id=v_project.id and kind='image' and status='queued';
 if v_project.visual_style = 'storybook' then
   update public.cloud_lesson_shots n
   set image_url = s.image_url, status = 'succeeded', completed_at = now()
   from public.cloud_lesson_scenes ns, public.cloud_lesson_scenes ss, public.cloud_lesson_shots s
   where n.project_id = v_project.id and ns.id = n.scene_id
     and ss.project_id = v_project.reused_from_project_id and ss.scene_index = ns.scene_index
     and s.scene_id = ss.id and s.shot_index = n.shot_index and s.image_url is not null;
   if exists(select 1 from public.cloud_lesson_shots where project_id = v_project.id and image_url is null) then
     raise exception 'Reusable visuals are incomplete';
   end if;
 end if;
 for v_scene in select n.id,n.scene_index,s.image_url,s.motion_mode,s.id as source_scene_id
   from public.cloud_lesson_scenes n join public.cloud_lesson_scenes s on s.scene_index=n.scene_index
   and s.project_id=v_project.reused_from_project_id where n.project_id=v_project.id
 loop
   select j.output_metadata->>'rawVideoUrl' into v_raw from public.cloud_lesson_jobs j
     where j.scene_id=v_scene.source_scene_id and j.kind='video' and j.status='succeeded';
   if v_scene.image_url is null or (v_scene.motion_mode='animate' and v_raw is null) then raise exception 'Reusable visuals are incomplete'; end if;
   update public.cloud_lesson_scenes set image_url=v_scene.image_url,motion_mode=v_scene.motion_mode,status='queued_video' where id=v_scene.id;
   insert into public.cloud_lesson_jobs(owner_id,project_id,scene_id,kind,source_image_url,max_attempts,parameters)
   values(v_project.owner_id,v_project.id,v_scene.id,'video',v_scene.image_url,2,
     jsonb_build_object('sceneIndex',v_scene.scene_index,'motionMode',v_scene.motion_mode,'clipSeconds',5,'slotSeconds',7.5,
       'reusedFromProjectId',v_project.reused_from_project_id,'reusedRawVideoUrl',v_raw));
 end loop;
 update public.cloud_lesson_projects set status='generating_videos' where id=v_project.id;
 return true;
end; $$;
revoke all on function public.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb) to service_role;

-- ── Job completion: a shot's picture ─────────────────────────────────────────
-- Jobs without a shot go to the previous function unchanged. A shot job saves
-- its picture; shot 1 of scene 1 releases every other shot with itself as the
-- style reference; the shot that completes a scene sets the scene's picture
-- (shot 1, the one Higgsfield animates) and queues the scene's video job.

alter function public.complete_cloud_lesson_job(uuid,text,text,jsonb,numeric) set schema private;
alter function private.complete_cloud_lesson_job(uuid,text,text,jsonb,numeric) rename to complete_cloud_lesson_job_original;
revoke all on function private.complete_cloud_lesson_job_original(uuid,text,text,jsonb,numeric)
 from public,anon,authenticated,service_role;

create function public.complete_cloud_lesson_job(
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
  c_video_negative constant text := 'text, writing, letters, numbers, captions, labels, logo, watermark, cuts, flicker, deformation, unstable geometry, frozen subject, static image, slideshow, camera-only motion, colour';
  v_job public.cloud_lesson_jobs;
  v_project public.cloud_lesson_projects;
  v_scene public.cloud_lesson_scenes;
  v_shot public.cloud_lesson_shots;
  v_first text;
begin
  if not exists (select 1 from public.cloud_lesson_jobs where id = p_job_id and shot_id is not null) then
    return private.complete_cloud_lesson_job_original(p_job_id, p_worker_id, p_output_url, p_output_metadata, p_cost_usd);
  end if;
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
  where id = p_job_id and worker_id = p_worker_id and status = 'processing' and kind = 'image'
  returning * into v_job;
  if not found then return false; end if;

  perform private.add_cloud_lesson_cost(v_job.project_id, 'image', p_cost_usd);

  select * into v_project from public.cloud_lesson_projects where id = v_job.project_id for update;
  if v_job.status = 'cancelled' or v_project.status in ('cancelled', 'failed', 'succeeded') then
    return true;
  end if;

  update public.cloud_lesson_shots
  set image_url = p_output_url, status = 'succeeded', completed_at = now()
  where id = v_job.shot_id
  returning * into v_shot;
  select * into v_scene from public.cloud_lesson_scenes where id = v_shot.scene_id;

  if v_scene.scene_index = 1 and v_shot.shot_index = 1 then
    update public.cloud_lesson_jobs
    set available_at = now(),
        parameters = parameters
          || pg_catalog.jsonb_build_object('styleReferenceUrl', p_output_url, 'awaitsStyleReference', false)
    where project_id = v_project.id and kind = 'image' and status = 'queued'
      and available_at = 'infinity'::timestamptz;
  end if;

  if not exists (select 1 from public.cloud_lesson_shots where scene_id = v_scene.id and image_url is null)
     and not exists (select 1 from public.cloud_lesson_jobs where scene_id = v_scene.id and kind = 'video') then
    select image_url into v_first from public.cloud_lesson_shots where scene_id = v_scene.id and shot_index = 1;
    update public.cloud_lesson_scenes
    set image_url = v_first, status = 'queued_video', error_message = null
    where id = v_scene.id
    returning * into v_scene;
    insert into public.cloud_lesson_jobs (
      owner_id, project_id, scene_id, kind, prompt, negative_prompt, source_image_url, max_attempts, parameters
    ) values (
      v_project.owner_id, v_project.id, v_scene.id, 'video', v_scene.video_prompt, c_video_negative, v_first, 2,
      pg_catalog.jsonb_build_object(
        'sceneIndex', v_scene.scene_index,
        'motionMode', v_scene.motion_mode,
        'clipSeconds', 5,
        'slotSeconds', v_scene.duration_seconds,
        'visualStyle', 'storybook',
        'shotCount', (select count(*) from public.cloud_lesson_shots where scene_id = v_scene.id)
      )
    );
  end if;

  if not exists (select 1 from public.cloud_lesson_scenes where project_id = v_project.id and image_url is null) then
    update public.cloud_lesson_projects set status = 'generating_videos'
    where id = v_project.id and status = 'generating_images';
  end if;

  return true;
end;
$$;
revoke all on function public.complete_cloud_lesson_job(uuid,text,text,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.complete_cloud_lesson_job(uuid,text,text,jsonb,numeric) to service_role;

-- ── Job failure: mark the shot too ──────────────────────────────────────────
-- Unchanged behaviour; a shot job that runs out of attempts also marks its shot
-- failed, so the progress view can say which picture failed.

alter function public.fail_cloud_lesson_job(uuid,text,text,text,integer,numeric) set schema private;
alter function private.fail_cloud_lesson_job(uuid,text,text,text,integer,numeric) rename to fail_cloud_lesson_job_original;
revoke all on function private.fail_cloud_lesson_job_original(uuid,text,text,text,integer,numeric)
 from public,anon,authenticated,service_role;

create function public.fail_cloud_lesson_job(
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
declare v_ok boolean;
begin
  v_ok := private.fail_cloud_lesson_job_original(
    p_job_id, p_worker_id, p_error_code, p_error_message, p_retry_delay_seconds, p_cost_usd);
  if v_ok then
    update public.cloud_lesson_shots t
    set status = case j.status when 'failed' then 'failed' else 'cancelled' end, completed_at = now()
    from public.cloud_lesson_jobs j
    where j.id = p_job_id and j.shot_id = t.id and j.status in ('failed', 'cancelled');
  end if;
  return v_ok;
end;
$$;
revoke all on function public.fail_cloud_lesson_job(uuid,text,text,text,integer,numeric) from public,anon,authenticated;
grant execute on function public.fail_cloud_lesson_job(uuid,text,text,text,integer,numeric) to service_role;

notify pgrst, 'reload schema';
