-- Behavioural tests for 20261010120000_cloud_lesson_engine.sql.
-- Run against a database with every migration applied. Any failed check raises.
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = notice;

create or replace function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', label; end if;
  raise notice 'ok  %', label;
end $$;

create or replace function pg_temp.as_user(sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sub, 'role', 'authenticated')::text, false);
end $$;

-- 8 valid scenes; scenes 3, 5 and 7 are `still`.
create or replace function pg_temp.scenes() returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'index', i,
    'fact', 'Plants make food from sunlight, water and air in their leaves. Fact ' || i,
    'narration', 'Leaves use sunlight to turn water and air into food, step ' || i || '.',
    'caption', 'Making food',
    'overlay', '{"kind":"none"}'::jsonb,
    'visualDescription', 'A broad green leaf in warm sunlight with water droplets on its surface',
    'motionDescription', 'Start: light falls on the leaf. Then: droplets glisten. End: the leaf glows.',
    'motionMode', case when i in (3, 5, 7) then 'still' else 'animate' end
  ) order by i) from generate_series(1, 8) i
$$;

-- ── 1. Teachers ──────────────────────────────────────────────────────────────
set role authenticated;
select pg_temp.as_user('user_teacher_a');

-- Editorial: the original look this test was written for (up to 6 animated scenes; illustrated allows 3).
select (r).id as lesson_a from (select public.reserve_cloud_lesson(7::smallint, 'Science', '  How   Plants Make Food ', 'kn-IN', 60::smallint, 'editorial') r) s \gset
select pg_temp.expect(
  (select status = 'preparing' and title is null and cache_key = '7|science|how plants make food|60|kn-IN'
          and content_key = '7|science|how plants make food|60'
   from public.cloud_lesson_projects where id = :'lesson_a'),
  'reserve creates a preparing lesson with a normalised cache key');
select pg_temp.expect(
  (select count(*) = 1 from public.cloud_lesson_jobs where project_id = :'lesson_a' and kind = 'prepare' and status = 'queued'),
  'reserve queues exactly one prepare job');

-- Rejected inputs.
do $$ begin
  perform public.reserve_cloud_lesson(7::smallint, 'Science', 'Photosynthesis', 'ta-IN', 60::smallint);
  raise exception 'FAILED: Tamil should be rejected';
exception when raise_exception then
  if sqlerrm like 'FAILED:%' then raise; end if;
  raise notice 'ok  languages outside English/Hindi/Kannada are rejected (%)', sqlerrm;
end $$;
do $$ begin
  perform public.reserve_cloud_lesson(7::smallint, 'Science', 'Photosynthesis', 'hi-IN', 90::smallint);
  raise exception 'FAILED: 90 s should be rejected';
exception when raise_exception then
  if sqlerrm like 'FAILED:%' then raise; end if;
  raise notice 'ok  durations other than 60 s are rejected';
end $$;

-- Active limit: a second lesson is fine, a third is refused.
select (r).id as lesson_a2 from (select public.reserve_cloud_lesson(7::smallint, 'Science', 'Water cycle', 'en-IN', 60::smallint) r) s \gset
do $$
declare v_hint text;
begin
  perform public.reserve_cloud_lesson(7::smallint, 'Science', 'Magnets', 'hi-IN', 60::smallint);
  raise exception 'FAILED: third active lesson should be refused';
exception when raise_exception then
  get stacked diagnostics v_hint = pg_exception_hint;
  if sqlerrm like 'FAILED:%' then raise; end if;
  if v_hint <> 'cloud_lesson_active_limit' then raise exception 'FAILED: wrong hint %', v_hint; end if;
  raise notice 'ok  third concurrent lesson is refused (%)', sqlerrm;
end $$;

-- RLS: another teacher sees nothing of teacher A's.
select pg_temp.as_user('user_teacher_b');
select pg_temp.expect((select count(*) = 0 from public.cloud_lesson_projects), 'teacher B cannot see teacher A''s lessons');
select pg_temp.expect((select count(*) = 0 from public.cloud_lesson_jobs), 'teacher B cannot see teacher A''s jobs');
select pg_temp.expect((select count(*) = 0 from public.cancel_cloud_lesson(:'lesson_a')), 'teacher B cannot cancel teacher A''s lesson');

-- Teachers cannot write tables directly or call worker functions.
do $$ begin
  update public.cloud_lesson_projects set status = 'succeeded';
  raise exception 'FAILED: direct update allowed';
exception when insufficient_privilege then raise notice 'ok  teachers cannot update lesson rows directly';
end $$;
do $$ begin
  perform public.claim_cloud_lesson_job('worker-x', array['prepare']);
  raise exception 'FAILED: teacher could claim jobs';
exception when insufficient_privilege then raise notice 'ok  teachers cannot call worker functions';
end $$;
do $$ begin
  perform private.add_cloud_lesson_cost(gen_random_uuid(), 'video', 1);
  raise exception 'FAILED: teacher reached private schema';
exception when insufficient_privilege then raise notice 'ok  teachers cannot reach the private schema';
end $$;
reset role;

set role anon;
select set_config('request.jwt.claims', '', false);
do $$ begin
  perform 1 from public.cloud_lesson_projects;
  raise exception 'FAILED: anon can read lessons';
exception when insufficient_privilege then raise notice 'ok  anonymous visitors cannot read lessons';
end $$;
do $$ begin
  perform public.reserve_cloud_lesson(7::smallint, 'Science', 'Photosynthesis', 'en-IN', 60::smallint);
  raise exception 'FAILED: anon can reserve';
exception when insufficient_privilege then raise notice 'ok  anonymous visitors cannot reserve lessons';
end $$;
reset role;

-- No storage select policy exists for the new bucket, so it cannot be listed.
select pg_temp.expect(
  (select count(*) = 0 from pg_policies where schemaname = 'storage' and qual like '%cloud-lesson-assets%'),
  'cloud-lesson-assets has no select (listing) policy');

-- ── 2. Workers: the full happy path ─────────────────────────────────────────
set role service_role;

select pg_temp.expect((select count(*) = 0 from public.claim_cloud_lesson_job('media-1', array['image','video','assemble'])),
  'a media worker finds nothing while lessons are only preparing');

select id as prep_job from public.claim_cloud_lesson_job('prep-1', array['prepare']) where project_id = :'lesson_a' \gset
-- (two lessons are queued; make sure we took lesson A's prepare job, else take the next)
select pg_temp.expect(:'prep_job' is not null, 'prep worker claims a prepare job');
select pg_temp.expect(public.heartbeat_cloud_lesson_job(:'prep_job', 'prep-1', 40::smallint) = 'ok', 'heartbeat returns ok');
select pg_temp.expect(public.heartbeat_cloud_lesson_job(:'prep_job', 'someone-else', 40::smallint) = 'lost', 'heartbeat from a non-owner worker returns lost');

select pg_temp.expect(public.complete_cloud_lesson_preparation(
  :'prep_job', 'prep-1', 'How plants make food', 'Explain how leaves make food using sunlight.',
  'Leaves use sunlight to turn water and air into food.', 'https://example.supabase.co/storage/v1/object/public/cloud-lesson-assets/a/narration.wav',
  60.05, pg_temp.scenes(), 0.0412, '{"textModel":"gemini-2.5-flash"}'), 'prepare completes');

select pg_temp.expect((select status = 'generating_images' and cost_usd = 0.0412 and (cost_breakdown->>'prepare')::numeric = 0.0412
  from public.cloud_lesson_projects where id = :'lesson_a'), 'lesson moves to generating_images and records prepare cost');
select pg_temp.expect((select count(*) = 8 from public.cloud_lesson_scenes where project_id = :'lesson_a'), '8 scenes written');
select pg_temp.expect((select count(*) = 3 from public.cloud_lesson_scenes where project_id = :'lesson_a' and motion_mode = 'still'), 'still scenes kept');
select pg_temp.expect((select count(*) filter (where available_at <= now()) = 1 and count(*) filter (where available_at = 'infinity') = 7
  from public.cloud_lesson_jobs where project_id = :'lesson_a' and kind = 'image'), 'only scene 1''s image is runnable; 2-8 wait for it');
select pg_temp.expect((select image_prompt like '% Vintage editorial photograph%' and video_prompt like '% Animate the subject physically: %'
  from public.cloud_lesson_scenes where project_id = :'lesson_a' and scene_index = 1), 'prompts use the shared house style and framing');

-- Scene 1 image.
select id as img1 from public.claim_cloud_lesson_job('media-1', array['image']) \gset
select pg_temp.expect((select scene_index = 1 from public.cloud_lesson_scenes s join public.cloud_lesson_jobs j on j.scene_id = s.id where j.id = :'img1'), 'first image claimed is scene 1');
select pg_temp.expect((select s.status = 'generating_image' from public.cloud_lesson_scenes s join public.cloud_lesson_jobs j on j.scene_id = s.id where j.id = :'img1'), 'scene shows generating_image');
select pg_temp.expect(public.complete_cloud_lesson_job(:'img1', 'media-1', 'https://cdn.example/a/s1.png', '{}', 0.039), 'scene 1 image completes');
select pg_temp.expect((select count(*) = 7 from public.cloud_lesson_jobs where project_id = :'lesson_a' and kind = 'image' and status = 'queued'
  and available_at <= now() and parameters->>'styleReferenceUrl' = 'https://cdn.example/a/s1.png'), 'scenes 2-8 released with scene 1 as style reference');
select pg_temp.expect((select count(*) = 1 from public.cloud_lesson_jobs where project_id = :'lesson_a' and kind = 'video'
  and source_image_url = 'https://cdn.example/a/s1.png' and parameters->>'motionMode' = 'animate'), 'scene 1 video job queued from its keyframe');

-- Remaining images, then all videos.
do $$
declare v_job public.cloud_lesson_jobs; n int := 0;
begin
  loop
    select * into v_job from public.claim_cloud_lesson_job('media-2', array['image', 'video']);
    exit when v_job.id is null;
    perform public.complete_cloud_lesson_job(v_job.id, 'media-2', 'https://cdn.example/out/' || v_job.id,
      '{}', case when v_job.kind = 'image' then 0.039 when v_job.parameters->>'motionMode' = 'animate' then 0.21 else 0 end);
    n := n + 1;
  end loop;
  raise notice 'processed % image/video jobs across both queued lessons', n;
end $$;

select pg_temp.expect((select status = 'assembling' from public.cloud_lesson_projects where id = :'lesson_a'), 'all clips in: lesson assembling');
select pg_temp.expect((select count(*) = 3 from public.cloud_lesson_jobs where project_id = :'lesson_a' and kind = 'video' and parameters->>'motionMode' = 'still'), 'still scenes get still video jobs');
select id as asm from public.claim_cloud_lesson_job('media-3', array['assemble']) \gset
select pg_temp.expect(public.complete_cloud_lesson_job(:'asm', 'media-3', 'https://cdn.example/a/lesson.mp4', '{}', 0), 'assembly completes');
select pg_temp.expect((select status = 'succeeded' and final_video_url = 'https://cdn.example/a/lesson.mp4'
  and cost_usd = round(0.0412 + 8 * 0.039 + 5 * 0.21, 4)
  and (cost_breakdown->>'image')::numeric = 0.312 and (cost_breakdown->>'video')::numeric = 1.05
  from public.cloud_lesson_projects where id = :'lesson_a'), 'lesson succeeds; cost = prepare + 8 images + 5 animated clips');
select pg_temp.expect(not public.complete_cloud_lesson_job(:'asm', 'media-3', 'https://cdn.example/x.mp4', '{}', 0), 'a job cannot be completed twice');
reset role;

-- ── 3. Failure, cancellation and crash recovery ─────────────────────────────
set role authenticated;
select pg_temp.as_user('user_teacher_a');
select pg_temp.expect((select count(*) = 1 from public.cancel_cloud_lesson(:'lesson_a2')), 'teacher A cancels their second, still-preparing lesson');
reset role;
set role authenticated;
select pg_temp.as_user('user_teacher_c');
select (r).id as lesson_c from (select public.reserve_cloud_lesson(5::smallint, 'Maths', 'Fractions', 'hi-IN', 60::smallint) r) s \gset
reset role;
set role service_role;

-- Crash recovery keeps the provider request id.
select id as prep_c from public.claim_cloud_lesson_job('prep-2', array['prepare']) \gset
select public.heartbeat_cloud_lesson_job(:'prep_c', 'prep-2', 10::smallint, 'hf-req-123') \gset
reset role;
update public.cloud_lesson_jobs set heartbeat_at = now() - interval '10 minutes' where id = :'prep_c';
set role service_role;
select id as prep_c2, provider_request_id as prid, attempts as att from public.claim_cloud_lesson_job('prep-3', array['prepare']) \gset
select pg_temp.expect(:'prep_c2' = :'prep_c' and :'prid' = 'hf-req-123' and :'att' = '2', 'a dead worker''s job is recovered with its provider request id');

-- Final attempt fails → lesson fails, nothing left queued.
select pg_temp.expect(public.fail_cloud_lesson_job(:'prep_c', 'prep-3', 'gemini_error', 'Gemini returned an error.', 5, 0.002), 'prepare failure recorded');
select pg_temp.expect((select status = 'failed' and error_message = 'Gemini returned an error.' and cost_usd = 0.002
  from public.cloud_lesson_projects where id = :'lesson_c'), 'out of attempts: lesson failed with its reason and partial cost');
reset role;

-- Cancellation is seen by the running worker at its next heartbeat.
set role authenticated;
select pg_temp.as_user('user_teacher_c');
select (r).id as lesson_d from (select public.reserve_cloud_lesson(5::smallint, 'Maths', 'Decimals', 'en-IN', 60::smallint) r) s \gset
reset role;
set role service_role;
select id as prep_d from public.claim_cloud_lesson_job('prep-4', array['prepare']) \gset
reset role;
set role authenticated;
select pg_temp.as_user('user_teacher_c');
select pg_temp.expect((select count(*) = 1 from public.cancel_cloud_lesson(:'lesson_d')), 'teacher cancels their own lesson');
reset role;
set role service_role;
select pg_temp.expect(public.heartbeat_cloud_lesson_job(:'prep_d', 'prep-4', 50::smallint) = 'cancel', 'worker learns of the cancel at its next heartbeat');
reset role;

-- Daily limit (10 per rolling 24 h).
set role authenticated;
select pg_temp.as_user('user_teacher_d');
do $$
declare v_id uuid; v_hint text;
begin
  for i in 1..10 loop
    select id into v_id from public.reserve_cloud_lesson(6::smallint, 'History', 'Topic number ' || i, 'en-IN', 60::smallint);
    perform public.cancel_cloud_lesson(v_id);  -- cancelled lessons still count toward the day
  end loop;
  perform public.reserve_cloud_lesson(6::smallint, 'History', 'One too many', 'en-IN', 60::smallint);
  raise exception 'FAILED: 11th lesson in a day allowed';
exception when raise_exception then
  get stacked diagnostics v_hint = pg_exception_hint;
  if sqlerrm like 'FAILED:%' then raise; end if;
  if v_hint <> 'cloud_lesson_daily_limit' then raise exception 'FAILED: wrong hint %', v_hint; end if;
  raise notice 'ok  11th lesson in 24 hours is refused (%)', sqlerrm;
end $$;
reset role;

-- ── 4. The RunPod engine is untouched and blind to cloud jobs ───────────────
set role service_role;
select pg_temp.expect((select count(*) = 0 from public.claim_lesson_video_job('runpod-1')), 'RunPod claim never returns cloud jobs');
reset role;
select pg_temp.expect((select count(*) = 0 from public.lesson_video_jobs), 'no rows written to the RunPod job table');

\echo ALL CLOUD LESSON TESTS PASSED
