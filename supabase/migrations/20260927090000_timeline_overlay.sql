-- Timeline overlay: scenes that state when something happened can show a
-- deterministic timeline (years drawn by the compositor, this scene's year
-- highlighted). Only the allowed overlay kinds change; everything else in
-- complete_lesson_video_preparation is identical to 20260926050000.

do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname from pg_constraint
    where conrelid = 'public.lesson_video_scenes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%overlay%kind%'
  loop
    execute format('alter table public.lesson_video_scenes drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table public.lesson_video_scenes
  add constraint lesson_video_scenes_overlay_check check (
    jsonb_typeof(overlay) = 'object'
    and overlay ->> 'kind' in ('none', 'arrow', 'equation', 'groups', 'bars', 'timeline')
  );

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
       or coalesce(v_overlay ->> 'kind', '') not in ('none', 'arrow', 'equation', 'groups', 'bars', 'timeline') then
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
