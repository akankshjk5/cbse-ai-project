-- Cloud lessons: four or eight slots, with an isolated illustrated presentation.
-- Existing projects retain their original editorial presentation.
alter table public.cloud_lesson_projects
  add column visual_style text not null default 'editorial' check (visual_style in ('editorial','illustrated'));
alter table public.cloud_lesson_projects alter column visual_style set default 'illustrated';
alter table public.cloud_lesson_projects drop constraint cloud_lesson_projects_target_duration_seconds_check;
alter table public.cloud_lesson_projects add constraint cloud_lesson_projects_target_duration_seconds_check
  check (target_duration_seconds in (30,60));

create or replace function private.reserve_cloud_lesson_uncached(
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
  if p_target_duration_seconds is null or p_target_duration_seconds not in (30,60) then
    raise exception 'Choose a 30- or 60-second lesson.' using hint = 'cloud_lesson_invalid';
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

create or replace function private.complete_cloud_lesson_preparation_original(
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
  v_animated integer := 0;
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

  v_expected := v_project.target_duration_seconds / 7.5;
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

    if v_mode='animate' then
      v_animated := v_animated + 1;
      if v_animated > (case when v_project.visual_style='illustrated' then case when v_expected=4 then 2 else 3 end else least(6,v_expected) end) then
        raise exception 'Too many animated scenes';
      end if;
    end if;
    v_image_prompt := pg_catalog.format('%s %s', v_visual,
      case when v_project.visual_style='illustrated' then
      'Clean 2D educational illustration, crisp bold outlines, simplified recognisable shapes, consistent teal coral and amber palette, soft flat shading, uncluttered pale blue background, subject fully visible, no text or lettering.'
      else c_house_style end);
    v_video_prompt := pg_catalog.format(
      '%s Animate the subject physically: %s Smooth, purposeful, physically plausible motion with stable object identity and a clear final state; the camera stays nearly still.',
      v_image_prompt, v_motion
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

-- Replace the public signature instead of exposing ambiguous RPC overloads.
drop function public.reserve_cloud_lesson(smallint,text,text,text,smallint);
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
 or p_visual_style is null or p_visual_style not in ('illustrated','editorial') then
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

 -- Only audited source plans with all eight ready scenes can be reused.
 select p.* into v_source from public.cloud_lesson_projects p
 where p.owner_id=v_owner and p.content_key=v_key and p.visual_style=p_visual_style and p.status='succeeded' and p.reused_from_project_id is null
 and exists(select 1 from public.cloud_lesson_jobs j where j.project_id=p.id and j.kind='prepare'
   and j.status='succeeded' and jsonb_typeof(j.output_metadata->'sourcePlan')='object')
 and (select count(*) from public.cloud_lesson_scenes s where s.project_id=p.id and s.status='succeeded' and s.image_url is not null)=p_target_duration_seconds/7.5
 and not exists(select 1 from public.cloud_lesson_scenes s where s.project_id=p.id and s.motion_mode='animate'
   and not exists(select 1 from public.cloud_lesson_jobs j where j.scene_id=s.id and j.kind='video' and j.status='succeeded'
     and coalesce(j.output_metadata->>'rawVideoUrl','') ~ '^https://'))
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
create or replace function public.complete_cloud_lesson_preparation(
 p_job_id uuid,p_worker_id text,p_title text,p_learning_objective text,p_narration_text text,
 p_narration_url text,p_narration_duration_seconds numeric,p_scenes jsonb,p_cost_usd numeric default 0,
 p_output_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_ok boolean; v_project public.cloud_lesson_projects; v_scene record; v_raw text;
begin
 v_ok := private.complete_cloud_lesson_preparation_original(p_job_id,p_worker_id,p_title,p_learning_objective,
   p_narration_text,p_narration_url,p_narration_duration_seconds,p_scenes,p_cost_usd,p_output_metadata);
 if not v_ok then return false; end if;
 select p.* into v_project from public.cloud_lesson_projects p join public.cloud_lesson_jobs j on j.project_id=p.id where j.id=p_job_id;
 if v_project.reused_from_project_id is null or v_project.status <> 'generating_images' then return true; end if;
 if not exists(select 1 from public.cloud_lesson_projects p where p.id=v_project.reused_from_project_id
   and p.owner_id=v_project.owner_id and p.status='succeeded' and p.content_key=v_project.content_key and p.visual_style=v_project.visual_style) then
   raise exception 'Visual reuse source is unavailable';
 end if;
 delete from public.cloud_lesson_jobs where project_id=v_project.id and kind='image' and status='queued';
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
notify pgrst,'reload schema';
