-- Run using Supabase db query --linked --file scripts/test-cloud-cache.sql.
-- All fixtures remain inside this transaction and are rolled back. Workers
-- cannot see them and no provider work can be triggered.
begin;
select set_config('request.jwt.claims','{"sub":"user_cloud_step7_fixture"}',true);
do $$
declare p public.cloud_lesson_projects; q public.cloud_lesson_projects;
 j public.cloud_lesson_jobs; s record; plan jsonb; ok boolean;
begin
 if has_function_privilege('authenticated','private.reserve_cloud_lesson_uncached(smallint,text,text,text,smallint)','execute')
 or has_function_privilege('anon','public.reserve_cloud_lesson(smallint,text,text,text,smallint,text)','execute') then
  raise exception 'Private/public grants are incorrect';
 end if;
 select * into p from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',60::smallint,'editorial');
 select * into q from public.reserve_cloud_lesson(6::smallint,' science ','Water   cycle','en-IN',60::smallint,'editorial');
 if p.id<>q.id then raise exception 'Repeated active requests created duplicate jobs'; end if;
 if (select count(*) from public.cloud_lesson_jobs where project_id=p.id)<>1 then raise exception 'Duplicate prepare jobs'; end if;
 select jsonb_agg(jsonb_build_object('index',n,'fact','Water circulates through the environment.',
  'narration','Water moves through the environment in a continuous natural cycle.',
  'caption','Water cycle','overlay',jsonb_build_object('kind','none'),
  'visualDescription','A clear water droplet centered against a plain background.',
  'motionDescription','Start: Water rests. Then: Water rises. End: Water settles.',
  'motionMode',case when n<=6 then 'animate' else 'still' end) order by n) into plan from generate_series(1,8) n;
 update public.cloud_lesson_jobs set status='processing',worker_id='fixture-worker',attempts=1 where project_id=p.id returning * into j;
 ok:=public.complete_cloud_lesson_preparation(j.id,'fixture-worker','Water cycle','Understand how water moves through the environment.',
  repeat('Water moves through the environment. ',8),'https://fixture.invalid/narration.wav',60,plan,0,
  jsonb_build_object('sourcePlan',jsonb_build_object('title','Water cycle','scenes',plan)));
 if not ok then raise exception 'Preparation completion failed'; end if;
 if (select count(*) from public.cloud_lesson_jobs where project_id=p.id and kind='image')<>8 then raise exception 'Fresh images were not queued'; end if;
 update public.cloud_lesson_scenes set status='succeeded',image_url='https://fixture.invalid/keyframe.png',video_url='https://fixture.invalid/scene.mp4' where project_id=p.id;
 for s in select * from public.cloud_lesson_scenes where project_id=p.id loop
  insert into public.cloud_lesson_jobs(owner_id,project_id,scene_id,kind,status,source_image_url,output_metadata)
  values(p.owner_id,p.id,s.id,'video','succeeded',s.image_url,
   case when s.motion_mode='animate' then jsonb_build_object('rawVideoUrl','https://fixture.invalid/raw.mp4') else '{}'::jsonb end);
 end loop;
 update public.cloud_lesson_projects set status='succeeded',final_video_url='https://fixture.invalid/lesson.mp4',completed_at=now() where id=p.id;
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',60::smallint,'editorial');
 if q.id<>p.id then raise exception 'Exact cache missed completed lesson'; end if;
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','hi-IN',60::smallint,'editorial');
 if q.reused_from_project_id is distinct from p.id then raise exception 'Language variant did not reserve visual reuse'; end if;
 update public.cloud_lesson_jobs set status='processing',worker_id='fixture-worker',attempts=1 where project_id=q.id and kind='prepare' returning * into j;
 ok:=public.complete_cloud_lesson_preparation(j.id,'fixture-worker','Water cycle','Understand how water moves through the environment.',
  repeat('Water moves through the environment. ',8),'https://fixture.invalid/new.wav',60,plan,0,'{}');
 if not ok or (select count(*) from public.cloud_lesson_jobs where project_id=q.id and kind='video')<>8
 or exists(select 1 from public.cloud_lesson_jobs where project_id=q.id and kind='image')
 or exists(select 1 from public.cloud_lesson_scenes where project_id=q.id and image_url is null)
 then raise exception 'Reuse must queue composition only and copy images'; end if;
 if (select count(*) from public.cloud_lesson_jobs where project_id=q.id and kind='video'
   and parameters->>'reusedRawVideoUrl' is not null)<>6 then raise exception 'Raw clips not retained'; end if;
 perform public.cancel_cloud_lesson(q.id);
 if exists(select 1 from public.cloud_lesson_jobs where project_id=q.id and status='queued') then raise exception 'Cancellation left queued work'; end if;
 perform set_config('request.jwt.claims','{"sub":"user_cloud_step7_other"}',true);
 select * into q from public.reserve_cloud_lesson(6::smallint,'Science','Water cycle','en-IN',60::smallint,'editorial');
 if q.id=p.id or q.reused_from_project_id is not null then raise exception 'Cache crossed owner boundary'; end if;
end; $$;
set local role authenticated;
do $$ begin
 if exists(select 1 from public.cloud_lesson_projects where owner_id<>'user_cloud_step7_other') then raise exception 'RLS exposed another owner'; end if;
end; $$;
reset role;
rollback;
select 'PASS: atomic cache, visual reuse, cancellation, private grants and owner RLS; fixtures rolled back' as result;
