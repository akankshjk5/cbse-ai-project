-- The video path's lifecycle, under failure.
--
--   npm run test:db
--
-- deck_jobs.sql covers the deck. This covers the primary product, whose
-- failure paths had never been asserted: a lesson becomes `succeeded` when its
-- assemble job completes, and that job is only created once every scene has
-- succeeded. Whether those two facts actually hold together under retries,
-- crashes and terminal failures is what this file is for.
--
-- The property that matters most is 2: a lesson must not be able to report
-- success while a scene is unfinished. A false success is worse than a
-- failure, because a teacher shows it to a class.
--
-- Each property signs in as its own teacher: reserve_cloud_lesson needs
-- clerk_user_id(), and the engine caps a teacher at two lessons generating at
-- once.

begin;

-- 1. An assemble job is not created while any scene is unfinished. This is the
--    guard the success condition leans on, so it is asserted directly rather
--    than inferred from the fact that lessons usually come out right.
select public.test_become('teacher_vid_p1');
do $$
declare p uuid; s1 uuid; s2 uuid; j uuid; n int;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Reflection', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 1, 7.5, 'Light bounces. This is scene 1 of the lesson.', 'Light bounces. Watch what happens next in this scene.',
          'a clear classroom diagram of a mirror, flat vector style, no text', 'a slow steady push towards a mirror, no camera shake',
          'a clear classroom diagram of a mirror, flat vector style, no text', 'a slow steady push towards a mirror, no camera shake',
          'still', 'queued_video')
  returning id into s1;
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 2, 7.5, 'Angles match. This is scene 2 of the lesson.', 'Angles match. Watch what happens next in this scene.',
          'a clear classroom diagram of two rays, flat vector style, no text', 'a slow steady push towards two rays, no camera shake',
          'a clear classroom diagram of two rays, flat vector style, no text', 'a slow steady push towards two rays, no camera shake',
          'still', 'queued_video')
  returning id into s2;

  -- Finish scene 1 only.
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, scene_id, kind, source_image_url, max_attempts, status,
     worker_id, attempts)
  values ('teacher_vid_p1', p, s1, 'video', 'https://example.test/1.png', 2,
          'processing', 'w1', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'generating_videos' where id = p;
  perform public.complete_cloud_lesson_job(j, 'w1', 'https://example.test/1.mp4');

  select count(*) into n from public.cloud_lesson_jobs
   where project_id = p and kind = 'assemble';
  if n <> 0 then
    raise exception 'an assemble job was created with scene 2 still unfinished';
  end if;
  raise notice 'ok  no assemble job while a scene is unfinished';
end $$;

-- 2. THE ONE THAT MATTERS. A lesson must not report success while a scene is
--    unfinished, however the assemble job came to exist.
select public.test_become('teacher_vid_p2');
do $$
declare p uuid; s1 uuid; s2 uuid; j uuid; st text; url text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Refraction Depth', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 1, 7.5, 'Light bends. This is scene 1 of the lesson.', 'Light bends. Watch what happens next in this scene.',
          'a clear classroom diagram of a prism, flat vector style, no text', 'a slow steady push towards a prism, no camera shake',
          'a clear classroom diagram of a prism, flat vector style, no text', 'a slow steady push towards a prism, no camera shake',
          'still', 'succeeded')
  returning id into s1;
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 2, 7.5, 'Water bends more. This is scene 2 of the lesson.', 'Water bends more. Watch what happens next in this scene.',
          'a clear classroom diagram of a glass, flat vector style, no text', 'a slow steady push towards a glass, no camera shake',
          'a clear classroom diagram of a glass, flat vector style, no text', 'a slow steady push towards a glass, no camera shake',
          'still', 'generating_video')
  returning id into s2;

  -- An assemble job exists and completes while scene 2 is still rendering.
  -- It can get here through a queue it was already on when a scene was
  -- retried, so the question is what completing it does.
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p2', p, 'assemble', 2, 'processing', 'w2', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'assembling' where id = p;
  perform public.complete_cloud_lesson_job(j, 'w2', 'https://example.test/lesson.mp4');

  select status, final_video_url into st, url
    from public.cloud_lesson_projects where id = p;
  if st = 'succeeded' then
    raise exception
      'FALSE SUCCESS: lesson reported succeeded with scene 2 at generating_video, '
      'final_video_url = %', coalesce(url, '(null)');
  end if;
  -- And the discrepancy is recorded rather than merely absent: a lesson that
  -- quietly stops short is as hard to diagnose as one that lies.
  if not exists (
    select 1 from public.cloud_lesson_jobs
    where id = j and status = 'succeeded'
      and error_code = 'assembled_with_unfinished_scenes'
  ) then
    raise exception 'the assemble job did not record why the lesson was held back';
  end if;
  raise notice 'ok  a lesson cannot report success while a scene is unfinished';
end $$;

-- 3. A scene job with a retry left goes back to the queue and does NOT fail
--    the lesson. A transient ComfyUI error must not lose a teacher's work.
select public.test_become('teacher_vid_p3');
do $$
declare p uuid; s uuid; j uuid; jst text; pst text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Dispersion', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 1, 7.5, 'White splits. This is scene 1 of the lesson.', 'White splits. Watch what happens next in this scene.',
          'a clear classroom diagram of a prism, flat vector style, no text', 'a slow steady push towards a prism, no camera shake',
          'a clear classroom diagram of a prism, flat vector style, no text', 'a slow steady push towards a prism, no camera shake',
          'still', 'generating_image')
  returning id into s;
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, scene_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p3', p, s, 'image', 2, 'processing', 'w3', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'generating_images' where id = p;

  perform public.fail_cloud_lesson_job(j, 'w3', 'comfy_error', 'ComfyUI refused the graph', 30, 0);

  select status into jst from public.cloud_lesson_jobs where id = j;
  select status into pst from public.cloud_lesson_projects where id = p;
  if jst <> 'queued' then
    raise exception 'a scene job with a retry left became % instead of queued', jst;
  end if;
  if pst = 'failed' then
    raise exception 'one retryable scene error failed the whole lesson';
  end if;
  raise notice 'ok  a retryable scene error requeues and leaves the lesson alive';
end $$;

-- 4. A scene job out of retries DOES fail the lesson, and cancels the work
--    still queued for it. A lesson missing a scene is not a lesson, so unlike
--    the deck this cascade is correct and is asserted so a later change cannot
--    quietly remove it.
select public.test_become('teacher_vid_p4');
do $$
declare p uuid; s uuid; j uuid; other uuid; pst text; ost text; sst text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Total Internal Reflection', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_scenes
    (project_id, scene_index, duration_seconds, fact, narration,
     visual_description, motion_description, image_prompt, video_prompt,
     motion_mode, status)
  values (p, 1, 7.5, 'Light trapped. This is scene 1 of the lesson.', 'Light trapped. Watch what happens next in this scene.',
          'a clear classroom diagram of a fibre, flat vector style, no text', 'a slow steady push towards a fibre, no camera shake',
          'a clear classroom diagram of a fibre, flat vector style, no text', 'a slow steady push towards a fibre, no camera shake',
          'still', 'generating_image')
  returning id into s;
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, scene_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p4', p, s, 'image', 2, 'processing', 'w4', 2)
  returning id into j;
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, status)
  values ('teacher_vid_p4', p, 'assemble', 2, 'queued')
  returning id into other;
  update public.cloud_lesson_projects set status = 'generating_images' where id = p;

  perform public.fail_cloud_lesson_job(j, 'w4', 'comfy_error', 'out of memory', 30, 0);

  select status into pst from public.cloud_lesson_projects where id = p;
  select status into ost from public.cloud_lesson_jobs where id = other;
  select status into sst from public.cloud_lesson_scenes where id = s;
  if pst <> 'failed' then
    raise exception 'a scene out of retries left the lesson at % instead of failed', pst;
  end if;
  if ost <> 'cancelled' then
    raise exception 'queued assemble work was left at % after the lesson failed', ost;
  end if;
  if sst <> 'failed' then
    raise exception 'the scene itself was left at % instead of failed', sst;
  end if;
  raise notice 'ok  a scene out of retries fails the lesson and cancels its queued work';
end $$;

-- 5. Completing a job on a lesson the teacher cancelled must not resurrect it.
select public.test_become('teacher_vid_p5');
do $$
declare p uuid; j uuid; st text; url text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Lenses', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p5', p, 'assemble', 2, 'processing', 'w5', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'cancelled' where id = p;

  perform public.complete_cloud_lesson_job(j, 'w5', 'https://example.test/late.mp4');

  select status, final_video_url into st, url
    from public.cloud_lesson_projects where id = p;
  if st <> 'cancelled' then
    raise exception 'a cancelled lesson became % when a late job completed', st;
  end if;
  if url is not null then
    raise exception 'a cancelled lesson was given a video url';
  end if;
  raise notice 'ok  a late completion does not resurrect a cancelled lesson';
end $$;

-- 6. An output URL that is not HTTPS is refused. A worker that handed back a
--    local path or an http:// URL would otherwise have it stored and rendered
--    into a <video src>.
select public.test_become('teacher_vid_p6');
do $$
declare p uuid; j uuid;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Mirrors', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p6', p, 'assemble', 2, 'processing', 'w6', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'assembling' where id = p;

  begin
    perform public.complete_cloud_lesson_job(j, 'w6', 'http://example.test/lesson.mp4');
    raise exception 'an http:// output url was accepted';
  exception when others then
    if sqlerrm not like '%HTTPS%' then raise; end if;
  end;
  begin
    perform public.complete_cloud_lesson_job(j, 'w6', '/tmp/lesson.mp4');
    raise exception 'a local path was accepted as an output url';
  exception when others then
    if sqlerrm not like '%HTTPS%' then raise; end if;
  end;
  raise notice 'ok  a non-HTTPS output url is refused';
end $$;

-- 7. A worker that no longer owns a job cannot complete it. Two workers after
--    a lease handover must not both write a result.
select public.test_become('teacher_vid_p7');
do $$
declare p uuid; j uuid; ok boolean; st text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Prisms', 'en-IN', 60::smallint, 'illustrated');
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, status, worker_id, attempts)
  values ('teacher_vid_p7', p, 'assemble', 2, 'processing', 'new-owner', 1)
  returning id into j;
  update public.cloud_lesson_projects set status = 'assembling' where id = p;

  ok := public.complete_cloud_lesson_job(j, 'evicted-worker', 'https://example.test/x.mp4');
  if ok then
    raise exception 'a worker that does not own the job completed it';
  end if;
  select status into st from public.cloud_lesson_projects where id = p;
  if st = 'succeeded' then
    raise exception 'an evicted worker marked the lesson succeeded';
  end if;
  raise notice 'ok  only the owning worker can complete a job';
end $$;

rollback;
