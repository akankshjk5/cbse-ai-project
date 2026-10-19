-- Deck-job properties. Needs a running Postgres:
--
--   npm run test:db
--
-- These cover the queue entry that was missing between a teacher asking for a
-- pptx and `Agents/lesson-deck.ts` building one. Before 20261019140000 a deck
-- request was accepted and nothing could claim the work, so the only honest
-- thing the route could do was refuse it.
--
-- Each property signs in as its own teacher: reserve_cloud_lesson needs
-- clerk_user_id(), and the engine caps a teacher at two lessons generating at
-- once.

begin;

-- NOTE on isolation: the whole file runs in one transaction, so deck jobs
-- queued by an earlier property are still queued when a later one claims.
-- Claiming is FIFO, so a property that wants to claim ITS OWN job retires the
-- others first. Without this, property 5 claimed property 2's job and the
-- failure read as a queue bug rather than as a test that shared state.

-- 1. A lesson that asked for video only cannot be given a deck job. A job
--    nobody ordered would spend planner time and show up in the teacher's
--    list as work they did not request.
select public.test_become('teacher_deck_p1');
do $$
declare p uuid;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Light and Shadow', 'en-IN', 60::smallint, 'illustrated');
  begin
    perform public.enqueue_cloud_lesson_deck(p);
    raise exception 'a deck was queued for a lesson that did not request one';
  exception when others then
    if sqlerrm not like '%did not request a deck%' then raise; end if;
  end;
  raise notice 'ok  a video-only lesson cannot be given a deck job';
end $$;

-- 2. Enqueueing twice produces one deck. The partial unique index is the
--    authority, so this holds whether or not the application is careful.
select public.test_become('teacher_deck_p2');
do $$
declare p uuid; a uuid; b uuid; n int;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Refraction', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  a := public.enqueue_cloud_lesson_deck(p);
  b := public.enqueue_cloud_lesson_deck(p);
  if a is distinct from b then
    raise exception 'two enqueues produced different jobs: % and %', a, b;
  end if;
  select count(*) into n from public.cloud_lesson_jobs
    where project_id = p and kind = 'deck';
  if n <> 1 then raise exception '% deck jobs for one lesson', n; end if;
  raise notice 'ok  two enqueues produce one deck job';
end $$;

-- 3. A deck belongs to a lesson, not a scene. The shape check must reject a
--    scene-bound deck, or a deck job would be claimable per scene and a
--    lesson would get one deck per picture.
select public.test_become('teacher_deck_p3');
do $$
declare p uuid;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Sound Waves', 'en-IN', 60::smallint, 'illustrated');
  begin
    insert into public.cloud_lesson_jobs (owner_id, project_id, kind, scene_id, max_attempts)
    values ('teacher_deck_p3', p, 'deck', extensions.gen_random_uuid(), 2);
    raise exception 'a deck job bound to a scene was accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok  a deck job cannot be bound to a scene';
end $$;

-- 4. An unknown lesson is refused rather than silently creating an orphan job.
select public.test_become('teacher_deck_p4');
do $$
begin
  begin
    perform public.enqueue_cloud_lesson_deck(extensions.gen_random_uuid());
    raise exception 'a deck was queued for a lesson that does not exist';
  exception when others then
    if sqlerrm not like '%No such lesson%' then raise; end if;
  end;
  raise notice 'ok  an unknown lesson cannot be given a deck job';
end $$;

-- 5. The deck worker claims only deck work, and claiming is exclusive. Two
--    workers asking at once must not both get the same job, which is what
--    `for update skip locked` inside claim_cloud_lesson_job is for.
select public.test_become('teacher_deck_p5');
do $$
declare p uuid; j uuid; first uuid; second uuid;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Magnetism', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);

  select id into first from public.claim_cloud_lesson_job('deck-worker-one', array['deck']);
  if first is distinct from j then
    raise exception 'the deck worker claimed % instead of the deck job %', first, j;
  end if;
  select id into second from public.claim_cloud_lesson_job('deck-worker-two', array['deck']);
  if second is not null then
    raise exception 'a second worker claimed the same deck job';
  end if;
  raise notice 'ok  a deck job is claimed once, by a worker asking for deck work';
end $$;

-- 6. A prepare worker must never pick up deck work. The kinds array is the
--    only thing separating the queues, so this is worth asserting rather
--    than assuming.
select public.test_become('teacher_deck_p6');
do $$
declare p uuid; claimed record;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Electric Circuits', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  perform public.enqueue_cloud_lesson_deck(p);
  -- Finish the prepare job this lesson created, so the only work left is the
  -- deck, then ask as a prepare-only worker.
  update public.cloud_lesson_jobs set status = 'succeeded'
    where project_id = p and kind = 'prepare';
  select * into claimed from public.claim_cloud_lesson_job('prepare-worker', array['prepare']);
  if claimed.id is not null and claimed.kind = 'deck' then
    raise exception 'a prepare worker claimed a deck job';
  end if;
  raise notice 'ok  a prepare worker does not claim deck work';
end $$;

-- 7. A deck job outlives its lesson succeeding. A request for both outputs
--    reaches 'succeeded' when the video finishes, and the deck must still be
--    claimable then -- otherwise it sits queued forever, which is the silent
--    wait this migration removed.
select public.test_become('teacher_deck_p7');
do $$
declare p uuid; j uuid; claimed uuid;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Gravity', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);
  update public.cloud_lesson_projects set status = 'succeeded' where id = p;
  select id into claimed from public.claim_cloud_lesson_job('deck-after-success', array['deck']);
  if claimed is distinct from j then
    raise exception 'a deck job was unclaimable once its lesson succeeded';
  end if;
  raise notice 'ok  a deck job is still claimable after the lesson succeeds';
end $$;

-- 8. But not after it failed or was cancelled. Building a deck for a lesson
--    the teacher abandoned spends planner time on nothing.
select public.test_become('teacher_deck_p8');
do $$
declare p uuid; claimed uuid;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Inertia', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  perform public.enqueue_cloud_lesson_deck(p);
  update public.cloud_lesson_projects set status = 'cancelled' where id = p;
  select id into claimed from public.claim_cloud_lesson_job('deck-after-cancel', array['deck']);
  if claimed is not null then
    raise exception 'a deck was built for a cancelled lesson';
  end if;
  raise notice 'ok  a cancelled lesson does not get a deck';
end $$;

-- 9. A lesson that has already succeeded survives its deck failing. This held
--    before 20261020090000 only because private.fail_cloud_lesson ignores a
--    project that is not mid-generation -- luck rather than design, so it is
--    asserted rather than assumed.
select public.test_become('teacher_deck_p9');
do $$
declare p uuid; j uuid; st text;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Photosynthesis', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);
  update public.cloud_lesson_projects set status = 'succeeded' where id = p;

  update public.cloud_lesson_jobs
    set status = 'processing', worker_id = 'w9', attempts = 2, max_attempts = 2
    where id = j;
  perform public.fail_cloud_lesson_job(j, 'w9', 'deck_failed', 'planner unreachable', 30, 0);

  select status into st from public.cloud_lesson_projects where id = p;
  if st <> 'succeeded' then
    raise exception 'a succeeded lesson became % because its deck failed', st;
  end if;
  raise notice 'ok  a succeeded lesson survives its deck failing';
end $$;

-- 10. The one this migration exists for. A deck that gives up while the video
--     is still rendering must not take the video with it. Before the fix this
--     produced: lesson status = failed, assemble jobs cancelled = 1.
select public.test_become('teacher_deck_p10');
do $$
declare p uuid; j uuid; st text; n_cancelled int; n_failed int;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Respiration', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);
  update public.cloud_lesson_projects set status = 'generating_videos' where id = p;
  insert into public.cloud_lesson_jobs (owner_id, project_id, kind, max_attempts)
    values ('teacher_deck_p10', p, 'assemble', 2);

  update public.cloud_lesson_jobs
    set status = 'processing', worker_id = 'w10', attempts = 2, max_attempts = 2
    where id = j;
  perform public.fail_cloud_lesson_job(j, 'w10', 'deck_failed', 'planner unreachable', 30, 0);

  select status into st from public.cloud_lesson_projects where id = p;
  if st = 'failed' then
    raise exception 'a failed deck marked the whole lesson failed while the video was rendering';
  end if;
  select count(*) into n_cancelled from public.cloud_lesson_jobs
    where project_id = p and kind = 'assemble' and status = 'cancelled';
  if n_cancelled > 0 then
    raise exception 'a failed deck cancelled % queued assemble job(s)', n_cancelled;
  end if;
  -- And the deck's own failure is still recorded, not swallowed.
  select count(*) into n_failed from public.cloud_lesson_jobs
    where id = j and status = 'failed' and error_code = 'deck_failed';
  if n_failed <> 1 then
    raise exception 'the deck failure was not recorded on its own job row';
  end if;
  raise notice 'ok  a failed deck leaves the video alone and records its own failure';
end $$;

-- 11. Retries. A deck job with attempts remaining goes back to 'queued' with a
--     backoff, and is not immediately claimable again -- otherwise a planner
--     that is down becomes a tight loop against it.
select public.test_become('teacher_deck_p11');
do $$
declare p uuid; j uuid; st text; avail timestamptz; claimed uuid;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Osmosis', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);

  update public.cloud_lesson_jobs
    set status = 'processing', worker_id = 'w11', attempts = 1, max_attempts = 2
    where id = j;
  perform public.fail_cloud_lesson_job(j, 'w11', 'deck_failed', 'planner timed out', 45, 0);

  select status, available_at into st, avail from public.cloud_lesson_jobs where id = j;
  if st <> 'queued' then
    raise exception 'a deck job with a retry left became % instead of queued', st;
  end if;
  if avail <= now() then
    raise exception 'a requeued deck job was immediately claimable; the backoff was not applied';
  end if;
  select id into claimed from public.claim_cloud_lesson_job('w11b', array['deck']);
  if claimed is not null then
    raise exception 'a backed-off deck job was claimed before its available_at';
  end if;
  raise notice 'ok  a deck job with a retry left is requeued behind a backoff';
end $$;

-- 12. A worker that crashed. Its lease expires, the queue recovers the job,
--     and recovering a deck must not fail the lesson either -- that is the
--     path 20261019140000 guarded, kept honest here.
select public.test_become('teacher_deck_p12');
do $$
declare p uuid; j uuid; st text; jst text;
begin
  update public.cloud_lesson_jobs set status = 'succeeded'
    where kind = 'deck' and status = 'queued';
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Diffusion', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects set requested_outputs = '{video,pptx}' where id = p;
  j := public.enqueue_cloud_lesson_deck(p);
  update public.cloud_lesson_projects set status = 'generating_videos' where id = p;

  -- A worker took it and died: processing, with a heartbeat well past the
  -- five-minute threshold, and no retries left so recovery is terminal.
  update public.cloud_lesson_jobs
    set status = 'processing', worker_id = 'dead', attempts = 2, max_attempts = 2,
        locked_at = now() - interval '20 minutes',
        heartbeat_at = now() - interval '20 minutes'
    where id = j;

  -- Any claim call runs the recovery sweep.
  perform public.claim_cloud_lesson_job('sweeper', array['deck']);

  select status into jst from public.cloud_lesson_jobs where id = j;
  if jst <> 'failed' then
    raise exception 'a crashed deck job with no retries left became % instead of failed', jst;
  end if;
  select status into st from public.cloud_lesson_projects where id = p;
  if st = 'failed' then
    raise exception 'recovering a crashed deck job failed the whole lesson';
  end if;
  raise notice 'ok  a crashed deck job fails itself without failing the lesson';
end $$;

rollback;
