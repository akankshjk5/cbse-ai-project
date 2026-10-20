-- Keyframe reuse: it must save GPU work without crossing a boundary.
--
--   npm run test:db
--
-- The speed claim and the safety claim are the same set of properties. A
-- lookup that returns more than it should is not a faster pipeline, it is a
-- data leak that happens to be quick.
--
-- No GPU is involved and nothing here measures time. What it proves is that
-- the lookup returns a usable URL in the cases where generation can be
-- skipped, and NULL in every case where it cannot.

begin;

-- A helper: a project with one scene whose image succeeded.
create or replace function pg_temp.seed(
  p_owner text, p_school uuid, p_topic text, p_prompt text,
  p_style text default 'illustrated', p_status text default 'succeeded',
  p_scene_status text default 'succeeded', p_url text default null)
returns uuid language plpgsql as $$
declare v_project uuid; v_scene uuid;
begin
  if p_school is not null then
    insert into public.schools (id, name)
    values (p_school, 'Test School ' || p_school::text)
    on conflict (id) do nothing;
  end if;
  insert into public.cloud_lesson_projects
    (owner_id, school_id, class_level, subject, topic, language_code,
     target_duration_seconds, visual_style, status, requested_outputs)
  values (p_owner, p_school, 9, 'Science', p_topic, 'en-IN', 60, p_style,
          p_status, '{video}')
  returning id into v_project;

  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status, image_url, completed_at)
  values (v_project, 1, 7.5, 'A fact long enough to pass.',
          'Narration for this scene.',
          'a clear classroom diagram, flat vector style, no text',
          'a slow steady push towards the diagram',
          p_prompt, 'a slow steady push towards the diagram',
          'still', p_scene_status,
          coalesce(p_url, 'https://example.test/' || v_project::text || '.png'),
          now())
  returning id into v_scene;
  return v_scene;
end; $$;

-- The scene we are asking on behalf of: same prompt, not yet generated.
create or replace function pg_temp.asker(
  p_owner text, p_school uuid, p_prompt text, p_style text default 'illustrated')
returns uuid language plpgsql as $$
declare v_project uuid; v_scene uuid;
begin
  if p_school is not null then
    insert into public.schools (id, name)
    values (p_school, 'Test School ' || p_school::text)
    on conflict (id) do nothing;
  end if;
  insert into public.cloud_lesson_projects
    (owner_id, school_id, class_level, subject, topic, language_code,
     target_duration_seconds, visual_style, status, requested_outputs)
  values (p_owner, p_school, 9, 'Science', 'Asking Lesson ' || gen_random_uuid()::text,
          'en-IN', 60, p_style, 'generating_images', '{video}')
  returning id into v_project;
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (v_project, 1, 7.5, 'A fact long enough to pass.',
          'Narration for this scene.',
          'a clear classroom diagram, flat vector style, no text',
          'a slow steady push towards the diagram',
          p_prompt, 'a slow steady push towards the diagram',
          'still', 'generating_image')
  returning id into v_scene;
  return v_scene;
end; $$;

-- 1. THE CASE THIS EXISTS FOR. A lesson that FAILED still holds good
--    keyframes, and lesson-level reuse refuses it because the project is not
--    succeeded. A retry must not redo that diffusion run.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('alice', null, 'Photosynthesis', 'a leaf cross-section, flat vector',
                      'illustrated', 'failed', 'succeeded');
  ask := pg_temp.asker('alice', null, 'a leaf cross-section, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is null then
    raise exception 'a keyframe from a FAILED lesson was not reused; the retry '
      'would regenerate it';
  end if;
  raise notice 'ok  a keyframe survives its lesson failing and is reused on retry';
end $$;

-- 2. Within a school, a colleague's keyframe is reusable -- the same rule
--    reserve_cloud_lesson applies to whole lessons.
do $$
declare school uuid := gen_random_uuid(); src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('bob', school, 'Respiration', 'a pair of lungs, flat vector');
  ask := pg_temp.asker('carol', school, 'a pair of lungs, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is null then
    raise exception 'a keyframe the school already paid for was not reused';
  end if;
  raise notice 'ok  a keyframe is reusable within the school that paid for it';
end $$;

-- 3. THE SAFETY PROPERTY. Across tenants, nothing is reused. A faster
--    pipeline that leaks another school's asset is not an improvement.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('dave', gen_random_uuid(), 'Osmosis', 'a cell membrane, flat vector');
  ask := pg_temp.asker('erin', gen_random_uuid(), 'a cell membrane, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'LEAK: a keyframe was reused across tenants (%)', url;
  end if;
  raise notice 'ok  no keyframe crosses a tenant boundary';
end $$;

-- 4. And not from a stranger with no school at all.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('frank', null, 'Diffusion', 'a gas jar, flat vector');
  ask := pg_temp.asker('grace', null, 'a gas jar, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'LEAK: a keyframe was reused between unrelated teachers (%)', url;
  end if;
  raise notice 'ok  two unrelated teachers do not share keyframes';
end $$;

-- 5. A different visual style is a different picture.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('helen', null, 'Gravity', 'an apple falling, flat vector',
                      'illustrated');
  ask := pg_temp.asker('helen', null, 'an apple falling, flat vector', 'storybook');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'a keyframe from a different visual style was reused';
  end if;
  raise notice 'ok  a different visual style does not reuse';
end $$;

-- 6. An older model's output must not be served as this model's. Without this
--    a model upgrade would silently keep shipping the old one's pictures.
do $$
declare src uuid; ask uuid; url text; src_proj uuid;
begin
  src := pg_temp.seed('ian', null, 'Inertia', 'a rolling ball, flat vector');
  select project_id into src_proj from public.cloud_lesson_scenes where id = src;
  update public.cloud_lesson_projects set generator_version = 'old-model'
   where id = src_proj;
  ask := pg_temp.asker('ian', null, 'a rolling ball, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'a keyframe from generator_version=old-model was reused';
  end if;
  raise notice 'ok  a keyframe from an older model version is not reused';
end $$;

-- 7. A scene that did not succeed has nothing to offer, even inside a lesson
--    that did.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('jane', null, 'Friction', 'a brake pad, flat vector',
                      'illustrated', 'succeeded', 'failed');
  ask := pg_temp.asker('jane', null, 'a brake pad, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'an unsucceeded scene''s image was reused';
  end if;
  raise notice 'ok  only a succeeded scene''s keyframe is reused';
end $$;

-- 8. A cancelled lesson is not a source. The teacher stopped it, and its
--    assets should not quietly reappear in someone else's lesson.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('kate', null, 'Momentum', 'a cue ball, flat vector',
                      'illustrated', 'cancelled', 'succeeded');
  ask := pg_temp.asker('kate', null, 'a cue ball, flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'a cancelled lesson''s keyframe was reused';
  end if;
  raise notice 'ok  a cancelled lesson is not a keyframe source';
end $$;

-- 9. A different prompt does not match, including by whitespace. A near-match
--    would put the wrong picture on a slide.
do $$
declare src uuid; ask uuid; url text;
begin
  src := pg_temp.seed('luke', null, 'Pressure', 'a barometer, flat vector');
  ask := pg_temp.asker('luke', null, 'a barometer,  flat vector');
  url := public.cloud_lesson_reusable_keyframe(ask);
  if url is not null then
    raise exception 'a prompt differing only in whitespace was treated as a match';
  end if;
  raise notice 'ok  a prompt that differs at all does not match';
end $$;

-- 10. A scene never reuses its own image, or a retry would "succeed" by
--     handing back the very thing it was asked to replace.
do $$
declare src uuid; url text;
begin
  src := pg_temp.seed('mary', null, 'Density', 'a hydrometer, flat vector');
  url := public.cloud_lesson_reusable_keyframe(src);
  if url is not null then
    raise exception 'a scene reused its own image (%)', url;
  end if;
  raise notice 'ok  a scene does not reuse its own image';
end $$;

-- 11. An empty prompt cannot exist to be matched.
--
--     The function guards against one anyway, but the stronger guarantee is
--     the database's: image_prompt carries a CHECK of at least 20 characters,
--     so the state the guard defends against is unreachable. Asserted here
--     rather than asserting the guard, because if that CHECK is ever relaxed
--     this property fails and points at the guard that then starts mattering.
do $$
begin
  begin
    perform pg_temp.seed('nina', null, 'Blank A', '');
    raise exception 'an empty image_prompt was accepted by the database';
  exception when check_violation then
    null;
  end;
  raise notice 'ok  an empty image_prompt cannot be stored, so it cannot be matched';
end $$;

-- 12. An unknown scene is NULL rather than an error: the worker asks before it
--     generates, and a lookup that throws would fail the job it was meant to
--     make cheaper.
do $$
begin
  if public.cloud_lesson_reusable_keyframe(gen_random_uuid()) is not null then
    raise exception 'an unknown scene returned a url';
  end if;
  raise notice 'ok  an unknown scene returns null rather than raising';
end $$;

rollback;
