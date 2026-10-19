-- ─────────────────────────────────────────────────────────────────────────────
-- 20261019140000 · A job kind for the deck
--
-- `requested_outputs` has accepted 'pptx' since 20261018090000, and nothing
-- ever built one. A teacher asking for a deck had a project reserved, stages
-- planned and an audit row written, then waited forever: there was no job kind
-- for it, so no worker could claim the work and no failure was ever recorded.
--
-- `Agents/lesson-deck.ts` builds a real editable deck and is tested. What was
-- missing was the queue entry between the request and that builder.
--
-- The deck job is enqueued by the application rather than from inside
-- `reserve_cloud_lesson`, which has been redefined six times and is the most
-- delicate function in the schema. Idempotency does not depend on the
-- application being careful: the partial unique index below means a second
-- enqueue for the same lesson cannot create a second deck job, so two
-- simultaneous requests produce one deck.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. 'deck' becomes a legal kind. Both checks are replaced rather than added
--    to, because a second overlapping CHECK would accept rows the first
--    rejects only by accident of evaluation order.
alter table public.cloud_lesson_jobs
  drop constraint if exists cloud_lesson_jobs_kind_check;
alter table public.cloud_lesson_jobs
  add constraint cloud_lesson_jobs_kind_check
  check (kind in ('prepare', 'image', 'video', 'assemble', 'deck'));

-- 2. A deck belongs to a lesson, not to a scene. Same shape as 'prepare' and
--    'assemble': no scene_id, no source_image_url.
alter table public.cloud_lesson_jobs
  drop constraint if exists cloud_lesson_jobs_shape_check;
alter table public.cloud_lesson_jobs
  add constraint cloud_lesson_jobs_shape_check check (
    (kind = 'prepare' and scene_id is null)
    or (kind = 'image' and scene_id is not null and source_image_url is null)
    or (kind = 'video' and scene_id is not null and source_image_url is not null)
    or (kind = 'assemble' and scene_id is null)
    or (kind = 'deck' and scene_id is null and source_image_url is null)
  );

-- 3. One deck per lesson. This is what makes the enqueue idempotent.
create unique index if not exists cloud_lesson_jobs_one_deck_idx
  on public.cloud_lesson_jobs (project_id) where kind = 'deck';

-- 4. Enqueue, idempotently.
--
--    Returns the existing job when there is one, so a caller cannot tell
--    whether it or someone else created it — which is the point. Refuses a
--    lesson that did not ask for a deck: a job nobody requested would spend
--    planner time and appear in the teacher's list as work they did not order.
create or replace function public.enqueue_cloud_lesson_deck(p_project_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_requested public.lesson_output_kind[];
  v_job uuid;
begin
  select p.owner_id, p.requested_outputs
    into v_owner, v_requested
  from public.cloud_lesson_projects p
  where p.id = p_project_id
  for share;

  if v_owner is null then
    raise exception 'No such lesson: %', p_project_id;
  end if;

  if not ('pptx' = any (v_requested)) then
    raise exception 'Lesson % did not request a deck', p_project_id;
  end if;

  -- The index is the authority. ON CONFLICT on a partial unique index needs
  -- the predicate repeated, so it is spelled out here.
  insert into public.cloud_lesson_jobs
    (owner_id, project_id, kind, max_attempts, parameters)
  values
    (v_owner, p_project_id, 'deck', 2, jsonb_build_object('outputKind', 'pptx'))
  on conflict (project_id) where kind = 'deck' do nothing
  returning id into v_job;

  if v_job is null then
    select j.id into v_job from public.cloud_lesson_jobs j
    where j.project_id = p_project_id and j.kind = 'deck';
  end if;

  return v_job;
end;
$$;

comment on function public.enqueue_cloud_lesson_deck is
  'Queues the one deck job for a lesson that asked for a pptx. Idempotent: a '
  'second call returns the first job. Refuses a lesson that did not request a deck.';

revoke all on function public.enqueue_cloud_lesson_deck(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_cloud_lesson_deck(uuid) to service_role;

-- 5. `lesson_outputs_ready` and friends already read `lesson_assets`, so a
--    finalised deck asset is visible to the reuse planner with no change here.
--    This comment exists so the next reader does not go looking for one.

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The queue has to be willing to hand out deck work.
--
-- Two separate reasons it would not, both found by running deck_jobs.sql
-- rather than by reading the function:
--
--   a) `p_kinds` is validated against a hardcoded list that did not include
--      'deck', so a deck worker was rejected before the queue was even read.
--
--   b) The candidate query requires the PROJECT to be mid-generation. A lesson
--      that asked for a video and a deck reaches 'succeeded' when the video
--      finishes, at which point its deck job becomes unclaimable: queued
--      forever, never failed, never built. Exactly the silent-wait this whole
--      migration exists to remove.
--
-- So a deck job is claimable whenever the lesson has not failed or been
-- cancelled, including after it has succeeded. The other kinds keep the
-- narrower gate: an image or video job outliving its project's generation
-- phase is a bug, not a deck waiting for its turn.
--
-- Reproduced from 20261010120000 with those two changes and no others.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.claim_cloud_lesson_job(p_worker_id text, p_kinds text[])
returns setof public.cloud_lesson_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.cloud_lesson_jobs;
  v_lost record;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) < 3 then
    raise exception 'A worker id is required';
  end if;
  if p_kinds is null or cardinality(p_kinds) < 1
     or not (p_kinds <@ array['prepare', 'image', 'video', 'assemble', 'deck']) then
    raise exception 'Job kinds must be a non-empty subset of prepare, image, video, assemble, deck';
  end if;

  for v_lost in
    update public.cloud_lesson_jobs
    -- available_at is left as it was, so a recovered job keeps its place at
    -- the front of the queue instead of going behind work queued since.
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        worker_id = null, locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when attempts < max_attempts then null else now() end
    where status = 'processing'
      and coalesce(heartbeat_at, locked_at, started_at, created_at) < now() - interval '5 minutes'
    returning project_id, status, kind
  loop
    -- A lost deck job must not fail the whole lesson: the video may be fine,
    -- and a teacher losing a finished video because a deck retry ran out is a
    -- worse outcome than a lesson with no deck.
    if v_lost.status = 'failed' and v_lost.kind <> 'deck' then
      perform private.fail_cloud_lesson(v_lost.project_id, 'A generation step stopped responding and ran out of retries.');
    end if;
  end loop;

  with candidate as (
    select j.id
    from public.cloud_lesson_jobs j
    join public.cloud_lesson_projects p on p.id = j.project_id
    where j.kind = any(p_kinds)
      and j.status = 'queued'
      and j.available_at <= now()
      and j.cancel_requested_at is null
      and j.attempts < j.max_attempts
      and (
        case when j.kind = 'deck'
          then p.status not in ('failed', 'cancelled')
          else p.status in ('preparing', 'generating_images', 'generating_videos', 'assembling')
        end
      )
    order by j.available_at, j.created_at
    for update of j skip locked
    limit 1
  )
  update public.cloud_lesson_jobs j
  set status = 'processing',
      progress = greatest(j.progress, 1),
      attempts = j.attempts + 1,
      worker_id = p_worker_id,
      locked_at = now(), heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()),
      error_code = null, error_message = null
  from candidate
  where j.id = candidate.id
  returning j.* into v_job;

  if v_job.id is null then return; end if;

  if v_job.kind in ('image', 'video') then
    update public.cloud_lesson_scenes
    set status = case v_job.kind when 'image' then 'generating_image' else 'generating_video' end
    where id = v_job.scene_id and status not in ('succeeded', 'failed', 'cancelled');
  end if;

  return next v_job;
end;
$$;

revoke all on function public.claim_cloud_lesson_job(text, text[])
  from public, anon, authenticated;
grant execute on function public.claim_cloud_lesson_job(text, text[]) to service_role;
