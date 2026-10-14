-- Transactional fixtures are invisible to running workers; no API calls.
begin;
select set_config('request.jwt.claims','{"sub":"user_cloud_duration_fixture"}',true);
do $$
declare p public.cloud_lesson_projects; q public.cloud_lesson_projects; j public.cloud_lesson_jobs; plan jsonb;
begin
 select * into p from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',30::smallint,'illustrated');
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',30::smallint,'illustrated');
 if p.id<>q.id or p.target_duration_seconds<>30 or p.visual_style<>'illustrated' then raise exception 'Invalid duration or duplicate request'; end if;
 select jsonb_agg(jsonb_build_object('index',n,'fact','Water circulates through the environment.',
  'narration','Water moves naturally through the environment in a cycle.','caption','Water cycle','overlay',jsonb_build_object('kind','none'),
  'visualDescription','A simple blue water droplet above a green hillside.',
  'motionDescription','Start: Water rests. Then: Water rises. End: Water settles.',
  'motionMode','still') order by n) into plan from generate_series(1,4) n;
 update public.cloud_lesson_jobs set status='processing',worker_id='duration-fixture',attempts=1 where project_id=p.id returning * into j;
 begin
  perform public.complete_cloud_lesson_preparation(j.id,'duration-fixture','Water cycle','Understand how water moves through the environment.',
   repeat('Water moves through the environment. ',4),'https://fixture.invalid/narration.wav',60,plan,0,'{}');
  raise exception 'Accepted wrong narration duration';
 exception when others then
  if sqlerrm='Accepted wrong narration duration' then raise; end if;
 end;
 if not public.complete_cloud_lesson_preparation(j.id,'duration-fixture','Water cycle','Understand how water moves through the environment.',
   repeat('Water moves through the environment. ',4),'https://fixture.invalid/narration.wav',30,plan,0,
   jsonb_build_object('sourcePlan',jsonb_build_object('title','Water cycle','scenes',plan))) then raise exception 'Preparation failed'; end if;
 if (select count(*) from public.cloud_lesson_scenes where project_id=p.id and duration_seconds=7.5)<>4
 or exists(select 1 from public.cloud_lesson_jobs where project_id=p.id and kind='image' and prompt not like '%Clean 2D educational illustration%')
 then raise exception 'Invalid scenes or style prompts'; end if;
 update public.cloud_lesson_scenes set status='succeeded',image_url='https://fixture.invalid/image.png',video_url='https://fixture.invalid/scene.mp4' where project_id=p.id;
 update public.cloud_lesson_jobs set status='succeeded' where project_id=p.id;
 update public.cloud_lesson_projects set status='succeeded',completed_at=now() where id=p.id;
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',30::smallint,'illustrated');
 if q.id<>p.id then raise exception 'Exact cache miss'; end if;
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',30::smallint,'editorial');
 if q.id=p.id or q.reused_from_project_id is not null then raise exception 'Style cache collision'; end if;
 perform public.cancel_cloud_lesson(q.id);
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',60::smallint,'illustrated');
 if q.id=p.id or q.reused_from_project_id is not null then raise exception 'Duration cache collision'; end if;
 perform public.cancel_cloud_lesson(q.id);
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','hi-IN',30::smallint,'illustrated');
 if q.reused_from_project_id<>p.id then raise exception 'Short source not reused'; end if;
 update public.cloud_lesson_jobs set status='processing',worker_id='duration-fixture',attempts=1 where project_id=q.id returning * into j;
 perform public.complete_cloud_lesson_preparation(j.id,'duration-fixture','Water cycle','Understand how water moves through the environment.',
  repeat('Water moves through the environment. ',4),'https://fixture.invalid/narration.wav',30,plan,0,'{}');
 if (select count(*) from public.cloud_lesson_jobs where project_id=q.id and kind='video')<>4
 or exists(select 1 from public.cloud_lesson_jobs where project_id=q.id and kind='image') then raise exception 'Short reuse queue mismatch'; end if;
end; $$;
rollback;
select 'PASS: 30-second preparation, invalid audio rejection, duration/style cache isolation and four-scene language reuse' as result;
