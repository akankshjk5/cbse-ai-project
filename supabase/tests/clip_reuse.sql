-- Clip reuse: the most expensive stage, so the most worth skipping.
--
--   npm run test:db
--
-- Wan's timeout is 1800s against 900s for a keyframe, so a hit here is worth
-- more than anywhere else in the pipeline. Which is also why the safety
-- properties matter more: reusing the wrong clip puts the wrong motion on a
-- lesson, and reusing another school's clip is a leak that happens to be fast.

begin;

-- A project with one ANIMATE scene whose video job succeeded and recorded a
-- raw clip. `p_image` and `p_prompt` are what matching turns on.
create or replace function pg_temp.clip_source(
  p_owner text, p_school uuid, p_image text, p_prompt text,
  p_style text default 'illustrated',
  p_project_status text default 'succeeded',
  p_scene_status text default 'succeeded',
  p_job_status text default 'succeeded',
  p_raw text default 'https://example.test/raw.mp4',
  p_duration numeric default 7.5)
returns uuid language plpgsql as $$
declare v_project uuid; v_scene uuid;
begin
  if p_school is not null then
    insert into public.schools (id, name)
    values (p_school, 'Test School ' || p_school::text) on conflict (id) do nothing;
  end if;
  insert into public.cloud_lesson_projects
    (owner_id, school_id, class_level, subject, topic, language_code,
     target_duration_seconds, visual_style, status, requested_outputs)
  values (p_owner, p_school, 9, 'Science', 'Clip Source ' || gen_random_uuid()::text,
          'en-IN', 60, p_style, p_project_status, '{video}')
  returning id into v_project;

  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status, image_url, completed_at)
  values (v_project, 1, p_duration, 'A fact long enough to pass.',
          'Narration for this scene.',
          'a clear classroom diagram, flat vector style, no text',
          'a slow steady push towards the diagram',
          'a clear classroom diagram, flat vector style, no text',
          p_prompt, 'animate', p_scene_status, p_image, now())
  returning id into v_scene;

  insert into public.cloud_lesson_jobs
    (owner_id, project_id, scene_id, kind, source_image_url, max_attempts,
     status, output_url, output_metadata)
  values (p_owner, v_project, v_scene, 'video', p_image, 2, p_job_status,
          'https://example.test/scene.mp4',
          jsonb_build_object('rawVideoUrl', p_raw));
  return v_scene;
end; $$;

-- The scene asking: same image and prompt, not yet animated.
create or replace function pg_temp.clip_asker(
  p_owner text, p_school uuid, p_image text, p_prompt text,
  p_style text default 'illustrated',
  p_motion text default 'animate',
  p_duration numeric default 7.5)
returns uuid language plpgsql as $$
declare v_project uuid; v_scene uuid;
begin
  if p_school is not null then
    insert into public.schools (id, name)
    values (p_school, 'Test School ' || p_school::text) on conflict (id) do nothing;
  end if;
  insert into public.cloud_lesson_projects
    (owner_id, school_id, class_level, subject, topic, language_code,
     target_duration_seconds, visual_style, status, requested_outputs)
  values (p_owner, p_school, 9, 'Science', 'Clip Asker ' || gen_random_uuid()::text,
          'en-IN', 60, p_style, 'generating_videos', '{video}')
  returning id into v_project;
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status, image_url)
  values (v_project, 1, p_duration, 'A fact long enough to pass.',
          'Narration for this scene.',
          'a clear classroom diagram, flat vector style, no text',
          'a slow steady push towards the diagram',
          'a clear classroom diagram, flat vector style, no text',
          p_prompt, p_motion, 'generating_video', p_image)
  returning id into v_scene;
  return v_scene;
end; $$;

-- 1. THE CASE THIS EXISTS FOR, and the one lesson-level reuse cannot serve: a
--    FAILED lesson's raw clip is still good motion over the same picture.
do $$
declare ask uuid; url text; src_project uuid;
begin
  perform pg_temp.clip_source('alice', null, 'https://example.test/leaf.png',
    'a slow push towards the leaf cross-section', 'illustrated', 'failed');
  ask := pg_temp.clip_asker('alice', null, 'https://example.test/leaf.png',
    'a slow push towards the leaf cross-section');
  select raw_video_url, source_project_id into url, src_project
    from public.cloud_lesson_reusable_clip(ask);
  if url is null then
    raise exception 'a raw clip from a FAILED lesson was not reused; Wan would run again';
  end if;
  if src_project is null then
    raise exception 'the source project id was not returned, so the worker cannot scope the download';
  end if;
  raise notice 'ok  a raw clip survives its lesson failing and is reused';
end $$;

-- 2. Within a school, a colleague's clip is reusable.
do $$
declare school uuid := gen_random_uuid(); ask uuid; url text;
begin
  perform pg_temp.clip_source('bob', school, 'https://example.test/lungs.png',
    'a slow push towards the lungs');
  ask := pg_temp.clip_asker('carol', school, 'https://example.test/lungs.png',
    'a slow push towards the lungs');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is null then
    raise exception 'a clip the school already paid for was not reused';
  end if;
  raise notice 'ok  a clip is reusable within the school that paid for it';
end $$;

-- 3. THE SAFETY PROPERTY. Nothing crosses a tenant boundary.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('dave', gen_random_uuid(), 'https://example.test/cell.png',
    'a slow push towards the membrane');
  ask := pg_temp.clip_asker('erin', gen_random_uuid(), 'https://example.test/cell.png',
    'a slow push towards the membrane');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'LEAK: a clip was reused across tenants (%)', url;
  end if;
  raise notice 'ok  no clip crosses a tenant boundary';
end $$;

-- 4. A DIFFERENT KEYFRAME is a different clip, even with identical motion.
--    This is the property that separates clip reuse from keyframe reuse: Wan
--    animates one specific picture.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('frank', null, 'https://example.test/one.png',
    'a slow push towards the diagram');
  ask := pg_temp.clip_asker('frank', null, 'https://example.test/two.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip animating a DIFFERENT keyframe was reused (%)', url;
  end if;
  raise notice 'ok  the same motion over a different keyframe does not reuse';
end $$;

-- 5. A different motion prompt over the same picture is a different clip.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('grace', null, 'https://example.test/same.png',
    'a slow push towards the diagram');
  ask := pg_temp.clip_asker('grace', null, 'https://example.test/same.png',
    'a slow pull away from the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip with different motion was reused';
  end if;
  raise notice 'ok  different motion over the same keyframe does not reuse';
end $$;

-- 6. A STILL scene gets nothing. It is FFmpeg zoompan, seconds of CPU, and has
--    no raw clip; answering would invite reuse of something free to make.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('helen', null, 'https://example.test/still.png',
    'a slow push towards the diagram');
  ask := pg_temp.clip_asker('helen', null, 'https://example.test/still.png',
    'a slow push towards the diagram', 'illustrated', 'still');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a still scene was offered a raw clip';
  end if;
  raise notice 'ok  a still scene is offered nothing';
end $$;

-- 7. A different slot length is a different clip: Wan's frame count is derived
--    from the duration.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('ian', null, 'https://example.test/dur.png',
    'a slow push towards the diagram', 'illustrated', 'succeeded', 'succeeded',
    'succeeded', 'https://example.test/raw.mp4', 7.5);
  ask := pg_temp.clip_asker('ian', null, 'https://example.test/dur.png',
    'a slow push towards the diagram', 'illustrated', 'animate', 10);
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip of a different duration was reused';
  end if;
  raise notice 'ok  a different slot length does not reuse';
end $$;

-- 8. A video job that did not succeed is not a source, however good its scene
--    looks.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('jane', null, 'https://example.test/jobfail.png',
    'a slow push towards the diagram', 'illustrated', 'succeeded', 'succeeded', 'failed');
  ask := pg_temp.clip_asker('jane', null, 'https://example.test/jobfail.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip from an unsucceeded video job was reused';
  end if;
  raise notice 'ok  only a succeeded video job is a clip source';
end $$;

-- 9. A job whose metadata lost the raw URL, or holds something that is not an
--    https URL, is not a source. A local path here would be downloaded by a
--    worker.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('kate', null, 'https://example.test/badraw.png',
    'a slow push towards the diagram', 'illustrated', 'succeeded', 'succeeded',
    'succeeded', '/tmp/raw.mp4');
  ask := pg_temp.clip_asker('kate', null, 'https://example.test/badraw.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a non-https raw clip was offered (%)', url;
  end if;
  raise notice 'ok  a raw clip that is not an https URL is refused';
end $$;

-- 10. A cancelled lesson is not a source.
do $$
declare ask uuid; url text;
begin
  perform pg_temp.clip_source('luke', null, 'https://example.test/cancel.png',
    'a slow push towards the diagram', 'illustrated', 'cancelled');
  ask := pg_temp.clip_asker('luke', null, 'https://example.test/cancel.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a cancelled lesson''s clip was reused';
  end if;
  raise notice 'ok  a cancelled lesson is not a clip source';
end $$;

-- 11. A different visual style or model version does not reuse, for the same
--     reasons as a keyframe.
do $$
declare ask uuid; url text; src uuid; src_proj uuid;
begin
  perform pg_temp.clip_source('mary', null, 'https://example.test/style.png',
    'a slow push towards the diagram', 'illustrated');
  ask := pg_temp.clip_asker('mary', null, 'https://example.test/style.png',
    'a slow push towards the diagram', 'storybook');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip from a different visual style was reused';
  end if;

  src := pg_temp.clip_source('mary', null, 'https://example.test/model.png',
    'a slow push towards the diagram');
  select project_id into src_proj from public.cloud_lesson_scenes where id = src;
  update public.cloud_lesson_projects set generator_version = 'old-model' where id = src_proj;
  ask := pg_temp.clip_asker('mary', null, 'https://example.test/model.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(ask);
  if url is not null then
    raise exception 'a clip from generator_version=old-model was reused';
  end if;
  raise notice 'ok  a different style or model version does not reuse';
end $$;

-- 12. A scene never reuses its own clip, and an unknown scene returns nothing
--     rather than raising -- the worker asks before it generates, and a lookup
--     that throws would fail the job it was meant to make cheaper.
do $$
declare src uuid; url text;
begin
  src := pg_temp.clip_source('nina', null, 'https://example.test/self.png',
    'a slow push towards the diagram');
  select raw_video_url into url from public.cloud_lesson_reusable_clip(src);
  if url is not null then
    raise exception 'a scene reused its own clip (%)', url;
  end if;
  select raw_video_url into url from public.cloud_lesson_reusable_clip(gen_random_uuid());
  if url is not null then
    raise exception 'an unknown scene returned a clip';
  end if;
  raise notice 'ok  no self-reuse, and an unknown scene returns nothing';
end $$;

rollback;
