-- Storybook style (20261011150000): transactional fixtures, rolled back at the end.
-- No API calls; invisible to running workers because nothing is committed.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-cloud-storybook.sql
begin;
select set_config('request.jwt.claims', '{"sub":"user_cloud_storybook_fixture"}', true);

create function pg_temp.scene(n integer, shots integer, mode text, title text default 'The Grand Bazaar') returns jsonb
language sql as $$
  select jsonb_build_object(
    'index', n,
    'fact', 'Shivaji Maharaj escaped from Agra hidden in a basket of sweets.',
    'narration', 'Shivaji Maharaj slipped out of Agra hidden inside a basket of sweets.',
    'caption', 'The escape',
    'overlay', jsonb_build_object('kind', 'none'),
    'visualDescription', 'Porters carrying large woven baskets of sweets through a stone gateway ' || n,
    'motionDescription', 'Start: porters stand at the gate. Then: they walk forward. End: they pass the guards.',
    'motionMode', mode,
    'title', title,
    'shots', (select jsonb_agg(jsonb_build_object(
        'shotSize', (array['wide','close','detail'])[s],
        'cameraMove', (array['push_in','pan_left','tilt_up'])[s],
        'visualDescription', case when s = 1
          then 'Porters carrying large woven baskets of sweets through a stone gateway ' || n
          else 'Shot ' || s || ' of scene ' || n || ': a close view of a woven basket lid' end) order by s)
      from generate_series(1, shots) s));
$$;

do $$
declare
  p public.cloud_lesson_projects; i public.cloud_lesson_projects; j public.cloud_lesson_jobs;
  plan jsonb; bad jsonb; v_job uuid; n integer; v_shots integer; v_url text;
begin
  -- 1. Reservation accepts storybook and still refuses unknown styles.
  select * into p from public.reserve_cloud_lesson(7::smallint, 'History', 'Escape from Agra', 'en-IN', 60::smallint, 'storybook');
  if p.visual_style <> 'storybook' then raise exception 'storybook not reserved'; end if;
  begin
    perform public.reserve_cloud_lesson(7::smallint, 'History', 'Other topic', 'en-IN', 60::smallint, 'watercolour');
    raise exception 'accepted unknown style';
  exception when others then if sqlerrm = 'accepted unknown style' then raise; end if; end;

  select jsonb_agg(pg_temp.scene(g, case when g % 2 = 0 then 3 else 2 end,
    case when g in (1, 4) then 'animate' else 'still' end) order by g) into plan
  from generate_series(1, 8) g;
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'sb-prep', attempts = 1
  where project_id = p.id and kind = 'prepare' returning * into j;

  -- 2. Bad storybook plans are refused and write nothing.
  foreach bad in array array[
    jsonb_set(plan, '{0,title}', '""'),                                   -- no title
    jsonb_set(plan, '{0,shots}', jsonb_build_array(plan -> 0 -> 'shots' -> 0)), -- one shot
    jsonb_set(plan, '{0,visualDescription}', '"A different picture from shot one entirely"'),
    jsonb_set(plan, '{0,shots,1,shotSize}', '"extreme"'),
    jsonb_set(plan, '{1,motionMode}', '"animate"')                         -- 3 animated > cap 2
  ] loop
    begin
      perform public.complete_cloud_lesson_preparation(j.id, 'sb-prep', 'Escape from Agra',
        'Explain how Shivaji Maharaj escaped from Agra.', repeat('Shivaji Maharaj escaped. ', 8),
        'https://fixture.invalid/narration.wav', 60, bad, 0, '{}');
      raise exception 'accepted a bad storybook plan';
    exception when others then if sqlerrm = 'accepted a bad storybook plan' then raise; end if; end;
  end loop;
  if exists(select 1 from public.cloud_lesson_scenes where project_id = p.id)
     or (select status from public.cloud_lesson_jobs where id = j.id) <> 'processing' then
    raise exception 'a refused plan wrote something';
  end if;

  -- 3. A valid plan: titles, shots, one image job per shot, scene 1 shot 1 first.
  if not public.complete_cloud_lesson_preparation(j.id, 'sb-prep', 'Escape from Agra',
      'Explain how Shivaji Maharaj escaped from Agra.', repeat('Shivaji Maharaj escaped. ', 8),
      'https://fixture.invalid/narration.wav', 60, plan, 0.08, '{}') then
    raise exception 'valid storybook plan refused';
  end if;
  select count(*) into v_shots from public.cloud_lesson_shots where project_id = p.id;
  if v_shots <> 20 then raise exception 'expected 20 shots, got %', v_shots; end if;
  if exists(select 1 from public.cloud_lesson_scenes where project_id = p.id and title is distinct from 'The Grand Bazaar')
     or exists(select 1 from public.cloud_lesson_scenes where project_id = p.id and image_prompt not like '%pen-and-ink engraving%')
     or exists(select 1 from public.cloud_lesson_scenes where project_id = p.id and video_prompt not like '%Keep the pen-and-ink engraving look%') then
    raise exception 'storybook scene titles or prompts missing';
  end if;
  if (select count(*) from public.cloud_lesson_jobs where project_id = p.id and kind = 'image') <> 20
     or exists(select 1 from public.cloud_lesson_jobs where project_id = p.id and kind = 'image' and shot_id is null)
     or (select count(*) from public.cloud_lesson_jobs where project_id = p.id and kind = 'image' and available_at <> 'infinity') <> 1
     or not exists(select 1 from public.cloud_lesson_jobs j2 join public.cloud_lesson_shots t on t.id = j2.shot_id
                   join public.cloud_lesson_scenes s on s.id = t.scene_id
                   where j2.project_id = p.id and j2.available_at <> 'infinity' and s.scene_index = 1 and t.shot_index = 1)
     or exists(select 1 from public.cloud_lesson_jobs where project_id = p.id and kind = 'image'
               and (negative_prompt not like '%photorealistic%' or prompt not like '%pen-and-ink engraving%')) then
    raise exception 'storybook image jobs wrong';
  end if;
  if (select status from public.cloud_lesson_projects where id = p.id) <> 'generating_images' then
    raise exception 'project should be generating images';
  end if;

  -- 4. Shot 1 of scene 1 releases every other shot with itself as the reference.
  select j2.id into v_job from public.cloud_lesson_jobs j2 where j2.project_id = p.id and j2.kind = 'image' and j2.available_at <> 'infinity';
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'sb-img', attempts = 1 where id = v_job;
  if not public.complete_cloud_lesson_job(v_job, 'sb-img', 'https://fixture.invalid/s1-1.png', '{}', 0.034) then
    raise exception 'shot completion refused';
  end if;
  if exists(select 1 from public.cloud_lesson_jobs where project_id = p.id and kind = 'image' and status = 'queued'
            and (available_at = 'infinity' or parameters ->> 'styleReferenceUrl' <> 'https://fixture.invalid/s1-1.png')) then
    raise exception 'other shots not released with the style reference';
  end if;
  if exists(select 1 from public.cloud_lesson_jobs where project_id = p.id and kind = 'video') then
    raise exception 'scene 1 queued a video before all its shots were drawn';
  end if;
  if (select image_url from public.cloud_lesson_scenes where project_id = p.id and scene_index = 1) is not null then
    raise exception 'scene picture set before all shots finished';
  end if;

  -- 5. The last shot of a scene sets its picture (shot 1) and queues one video job.
  for v_job, n in
    select j2.id, s.scene_index from public.cloud_lesson_jobs j2
    join public.cloud_lesson_shots t on t.id = j2.shot_id join public.cloud_lesson_scenes s on s.id = t.scene_id
    where j2.project_id = p.id and j2.status = 'queued' order by s.scene_index, t.shot_index
  loop
    update public.cloud_lesson_jobs set status = 'processing', worker_id = 'sb-img', attempts = 1 where id = v_job;
    perform public.complete_cloud_lesson_job(v_job, 'sb-img', 'https://fixture.invalid/' || v_job || '.png', '{}', 0.034);
  end loop;
  if (select count(*) from public.cloud_lesson_jobs where project_id = p.id and kind = 'video') <> 8
     or exists(select 1 from public.cloud_lesson_jobs v join public.cloud_lesson_scenes s on s.id = v.scene_id
               join public.cloud_lesson_shots t on t.scene_id = s.id and t.shot_index = 1
               where v.project_id = p.id and v.kind = 'video'
               and (v.source_image_url <> t.image_url or s.image_url <> t.image_url
                    or (v.parameters ->> 'shotCount')::integer <> (select count(*) from public.cloud_lesson_shots where scene_id = s.id)
                    or v.parameters ->> 'motionMode' <> s.motion_mode)) then
    raise exception 'scene video jobs wrong';
  end if;
  if exists(select 1 from public.cloud_lesson_shots where project_id = p.id and (status <> 'succeeded' or image_url is null))
     or (select status from public.cloud_lesson_projects where id = p.id) <> 'generating_videos'
     or (select (cost_breakdown ->> 'image')::numeric from public.cloud_lesson_projects where id = p.id) <> round(20 * 0.034, 4) then
    raise exception 'shots, status or image cost wrong';
  end if;
  -- A completed shot job cannot be completed again.
  if public.complete_cloud_lesson_job(v_job, 'sb-img', 'https://fixture.invalid/again.png', '{}', 0) then
    raise exception 'a shot job completed twice';
  end if;

  -- 6. Existing styles: shots are refused, and their images still flow scene by scene.
  select * into i from public.reserve_cloud_lesson(7::smallint, 'History', 'Escape from Agra', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'il-prep', attempts = 1
  where project_id = i.id and kind = 'prepare' returning * into j;
  begin
    perform public.complete_cloud_lesson_preparation(j.id, 'il-prep', 'Escape from Agra',
      'Explain how Shivaji Maharaj escaped from Agra.', repeat('Shivaji Maharaj escaped. ', 8),
      'https://fixture.invalid/narration.wav', 60, plan, 0, '{}');
    raise exception 'illustrated lesson accepted shots';
  exception when others then if sqlerrm = 'illustrated lesson accepted shots' then raise; end if; end;
  select jsonb_agg((value - 'shots' - 'title') || jsonb_build_object('motionMode', 'still')) into plan
  from jsonb_array_elements(plan);
  if not public.complete_cloud_lesson_preparation(j.id, 'il-prep', 'Escape from Agra',
      'Explain how Shivaji Maharaj escaped from Agra.', repeat('Shivaji Maharaj escaped. ', 8),
      'https://fixture.invalid/narration.wav', 60, plan, 0, '{}') then
    raise exception 'illustrated plan refused';
  end if;
  if exists(select 1 from public.cloud_lesson_shots where project_id = i.id)
     or (select count(*) from public.cloud_lesson_jobs where project_id = i.id and kind = 'image' and shot_id is null) <> 8
     or exists(select 1 from public.cloud_lesson_scenes where project_id = i.id and (title is not null or image_prompt not like '%Clean 2D educational illustration%')) then
    raise exception 'illustrated lesson changed by the storybook migration';
  end if;
  select id into v_job from public.cloud_lesson_jobs where project_id = i.id and kind = 'image' and available_at <> 'infinity';
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'il-img', attempts = 1 where id = v_job;
  if not public.complete_cloud_lesson_job(v_job, 'il-img', 'https://fixture.invalid/il-1.png', '{}', 0.034) then
    raise exception 'illustrated image completion refused';
  end if;
  if not exists(select 1 from public.cloud_lesson_jobs where project_id = i.id and kind = 'video')
     or exists(select 1 from public.cloud_lesson_jobs where project_id = i.id and kind = 'image' and available_at = 'infinity') then
    raise exception 'illustrated image completion no longer delegates to the original';
  end if;

  -- 7. A shot that runs out of attempts marks the shot failed and fails the lesson.
  -- (A second teacher, so the two-active-lessons limit does not refuse it.)
  perform set_config('request.jwt.claims', '{"sub":"user_cloud_storybook_third"}', true);
  select * into p from public.reserve_cloud_lesson(7::smallint, 'History', 'Battle of Pratapgad', 'en-IN', 30::smallint, 'storybook');
  select jsonb_agg(pg_temp.scene(g, 2, 'still') order by g) into plan from generate_series(1, 4) g;
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'sb-prep2', attempts = 1
  where project_id = p.id and kind = 'prepare' returning * into j;
  perform public.complete_cloud_lesson_preparation(j.id, 'sb-prep2', 'Battle of Pratapgad',
    'Describe the battle of Pratapgad.', repeat('The battle was fought. ', 6),
    'https://fixture.invalid/narration.wav', 30, plan, 0, '{}');
  select id into v_job from public.cloud_lesson_jobs where project_id = p.id and kind = 'image' and available_at <> 'infinity';
  update public.cloud_lesson_jobs set status = 'processing', worker_id = 'sb-img2', attempts = max_attempts where id = v_job;
  if not public.fail_cloud_lesson_job(v_job, 'sb-img2', 'image_failed', 'The picture could not be drawn.', 30, 0.01) then
    raise exception 'shot failure refused';
  end if;
  if (select t.status from public.cloud_lesson_shots t join public.cloud_lesson_jobs j2 on j2.shot_id = t.id where j2.id = v_job) <> 'failed'
     or (select status from public.cloud_lesson_projects where id = p.id) <> 'failed' then
    raise exception 'shot failure not recorded';
  end if;
end $$;

-- 8. Teachers read only their own shots; anonymous visitors read none.
do $$ begin
  if (select count(*) from public.cloud_lesson_shots) = 0 then raise exception 'fixture has no shots'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_cloud_storybook_other"}', true);
do $$ begin
  if exists(select 1 from public.cloud_lesson_shots) then raise exception 'RLS exposed another teacher''s shots'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"user_cloud_storybook_fixture"}', true);
do $$ begin
  if (select count(*) from public.cloud_lesson_shots) <> 20 then raise exception 'owner cannot read their shots'; end if;
  begin
    insert into public.cloud_lesson_shots (project_id, scene_id, shot_index, shot_size, visual_description, image_prompt)
    select project_id, scene_id, 3, 'wide', 'An extra shot nobody asked for here', 'An extra shot nobody asked for here'
    from public.cloud_lesson_shots limit 1;
    raise exception 'a teacher could write shots';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.cloud_lesson_shots;
    raise exception 'anonymous visitor read shots';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
select 'PASS: storybook reservation, plan checks, shots and style-reference release, scene video handoff, shot failure, existing styles unchanged, shot RLS; fixtures rolled back' as result;
