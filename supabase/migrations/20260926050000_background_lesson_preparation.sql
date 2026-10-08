-- Save a lesson request before local planning/TTS begins. Browser navigation must
-- not own the lifetime of the expensive preparation step.
alter table public.lesson_video_projects
  drop constraint if exists lesson_video_projects_status_check;

alter table public.lesson_video_projects
  add constraint lesson_video_projects_status_check check (status in (
    'preparing', 'generating_images', 'generating_videos', 'assembling',
    'succeeded', 'failed', 'cancelled'
  ));

create or replace function public.reserve_lesson_video_project(
  p_class_level smallint,
  p_subject text,
  p_topic text,
  p_language_code text,
  p_language_name text,
  p_target_duration_seconds smallint
)
returns setof public.lesson_video_projects
language plpgsql security definer set search_path = public
as $$
declare
  v_owner text := public.clerk_user_id();
  v_project public.lesson_video_projects;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_class_level not between 1 and 12 then raise exception 'Invalid class'; end if;
  if char_length(trim(p_subject)) not between 2 and 100 then raise exception 'Invalid subject'; end if;
  if char_length(trim(p_topic)) not between 3 and 300 then raise exception 'Invalid topic'; end if;
  if p_language_code not in ('en-IN','hi-IN','bn-IN','gu-IN','kn-IN','ml-IN','mr-IN','ta-IN','te-IN') then
    raise exception 'Unsupported narration language';
  end if;
  if char_length(trim(p_language_name)) not between 2 and 50 then raise exception 'Invalid language name'; end if;
  if p_target_duration_seconds not in (60, 90) then raise exception 'Invalid duration'; end if;

  insert into public.lesson_video_projects (
    owner_id, class_level, subject, topic, language_code, language_name,
    target_duration_seconds, title, learning_objective, narration_text, status
  ) values (
    v_owner, p_class_level, trim(p_subject), trim(p_topic), p_language_code,
    trim(p_language_name), p_target_duration_seconds, left(trim(p_topic), 200),
    'Preparing the lesson plan', 'Preparing the lesson narration', 'preparing'
  ) returning * into v_project;
  return next v_project;
end;
$$;

revoke all on function public.reserve_lesson_video_project(smallint,text,text,text,text,smallint) from public, anon;
grant execute on function public.reserve_lesson_video_project(smallint,text,text,text,text,smallint) to authenticated;

create or replace function public.complete_lesson_video_preparation(
  p_project_id uuid,
  p_title text,
  p_learning_objective text,
  p_narration_text text,
  p_scenes jsonb
)
returns setof public.lesson_video_projects
language plpgsql security definer set search_path = public
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
  v_caption text;
  v_overlay jsonb;
  v_house_style constant text := 'Vintage editorial photograph with muted warm tones, soft diffused window light, gentle film grain, shallow depth of field, the subject centered and fully visible against a plain seamless warm-grey studio backdrop, generous empty space around it.';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select * into v_project from public.lesson_video_projects
    where id = p_project_id and owner_id = v_owner and status = 'preparing'
    for update;
  if not found then raise exception 'Lesson preparation was cancelled or already completed'; end if;
  if char_length(trim(p_title)) not between 3 and 200
     or char_length(trim(p_learning_objective)) not between 10 and 500
     or char_length(trim(p_narration_text)) not between 20 and 8000 then
    raise exception 'Invalid lesson content';
  end if;
  v_expected_count := case when v_project.target_duration_seconds = 60 then 8 else 12 end;
  if jsonb_typeof(p_scenes) <> 'array' or jsonb_array_length(p_scenes) <> v_expected_count then
    raise exception 'Expected % lesson scenes', v_expected_count;
  end if;
  v_scene_duration := v_project.target_duration_seconds::numeric / v_expected_count::numeric;

  update public.lesson_video_projects
  set title = trim(p_title), learning_objective = trim(p_learning_objective),
      narration_text = trim(p_narration_text), status = 'generating_images'
  where id = p_project_id returning * into v_project;

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
    v_caption := trim(coalesce(v_scene ->> 'caption', ''));
    v_overlay := coalesce(v_scene -> 'overlay', '{"kind":"none"}'::jsonb);
    if char_length(v_fact) not between 10 and 500
       or char_length(v_narration) not between 5 and 800
       or char_length(v_visual) not between 20 and 1200
       or char_length(v_motion) not between 15 and 800
       or char_length(v_caption) > 120
       or jsonb_typeof(v_overlay) <> 'object'
       or coalesce(v_overlay ->> 'kind', '') not in ('none', 'arrow', 'equation', 'groups', 'bars') then
      raise exception 'Lesson scene % has invalid content lengths', v_index;
    end if;

    v_image_prompt := format('%s %s', v_visual, v_house_style);
    v_video_prompt := format(
      '%s Animate the subject physically: %s Smooth, purposeful, physically plausible motion with stable object identity and a clear final state; the camera stays nearly still.',
      v_visual, v_motion
    );
    insert into public.lesson_video_scenes (
      project_id, scene_index, duration_seconds, fact, narration,
      image_prompt, video_prompt, caption, overlay
    ) values (
      v_project.id, v_index, v_scene_duration, v_fact, v_narration,
      v_image_prompt, v_video_prompt, v_caption, v_overlay
    ) returning * into v_scene_row;

    insert into public.lesson_video_jobs (
      owner_id, project_id, scene_id, kind, profile, prompt,
      negative_prompt, max_attempts, parameters
    ) values (
      v_owner, v_project.id, v_scene_row.id, 'image', 'image-fast', v_image_prompt,
      'text, writing, letters, numbers, watermark, logo, distorted anatomy, duplicate subjects, low quality',
      4, jsonb_build_object('width', 1024, 'height', 576, 'steps', 8,
        'sceneIndex', v_index, 'seed', 1000 + v_index)
    );
  end loop;
  return next v_project;
end;
$$;

revoke all on function public.complete_lesson_video_preparation(uuid,text,text,text,jsonb) from public, anon;
grant execute on function public.complete_lesson_video_preparation(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.cancel_lesson_video_project(p_project_id uuid)
returns setof public.lesson_video_projects
language plpgsql security definer set search_path = public
as $$
declare v_project public.lesson_video_projects;
begin
  update public.lesson_video_projects
  set status = 'cancelled', completed_at = now(), error_message = null
  where id = p_project_id and owner_id = public.clerk_user_id()
    and status in ('preparing', 'generating_images', 'generating_videos', 'assembling')
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
  p_project_id uuid, p_error_message text
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare changed integer;
begin
  update public.lesson_video_projects
  set status = 'failed', error_message = left(p_error_message, 2000), completed_at = now()
  where id = p_project_id and owner_id = public.clerk_user_id()
    and narration_url is null
    and status in ('preparing', 'generating_images', 'generating_videos');
  get diagnostics changed = row_count;
  if changed = 1 then
    update public.lesson_video_jobs
    set cancel_requested_at = now(),
        status = case when status = 'queued' then 'cancelled' else status end,
        completed_at = case when status = 'queued' then now() else completed_at end
    where project_id = p_project_id and status in ('queued', 'processing');
  end if;
  return changed = 1;
end;
$$;

revoke all on function public.cancel_lesson_video_project(uuid) from public, anon;
revoke all on function public.fail_lesson_video_setup(uuid,text) from public, anon;
grant execute on function public.cancel_lesson_video_project(uuid) to authenticated;
grant execute on function public.fail_lesson_video_setup(uuid,text) to authenticated;
