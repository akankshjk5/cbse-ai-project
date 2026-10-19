-- ─────────────────────────────────────────────────────────────────────────────
-- 20261020090000 · A failed deck must not destroy the lesson
--
-- 20261019140000 added the 'deck' job kind and guarded ONE of the two paths
-- that can fail a job terminally. It guarded the stale-lease recovery loop
-- inside claim_cloud_lesson_job, and missed the ordinary one: a worker
-- reporting failure through fail_cloud_lesson_job.
--
-- That function ends with an unconditional
--
--     perform private.fail_cloud_lesson(v_job.project_id, p_error_message);
--
-- for any kind. private.fail_cloud_lesson sets the project to 'failed' when it
-- is mid-generation and cancels every queued job on it. So a deck job that
-- exhausted its retries while the video was still rendering took the video
-- with it:
--
--     lesson status = failed, assemble jobs cancelled = 1
--
-- A teacher who asked for a video and a deck lost the video because the
-- planner was briefly unreachable for the deck. Demonstrated against
-- PostgreSQL 18.1 before this migration was written; deck_jobs.sql properties
-- 9 to 12 hold it shut.
--
-- A lesson that has already succeeded was never at risk, because
-- private.fail_cloud_lesson only touches a project whose status is one of the
-- four in-progress values. That is luck rather than design, so it is now
-- asserted too.
--
-- The rule: a terminally failed deck records its failure on the job row and
-- changes nothing else. The video is independent work and the teacher keeps
-- it; `lesson_outputs_outstanding` already reports the deck as missing, which
-- is the honest state.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fail_cloud_lesson_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry_delay_seconds integer default 30,
  p_cost_usd numeric default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.cloud_lesson_jobs;
begin
  update public.cloud_lesson_jobs
  set status = case
        when cancel_requested_at is not null then 'cancelled'
        when attempts < max_attempts then 'queued'
        else 'failed' end,
      available_at = case
        when cancel_requested_at is null and attempts < max_attempts
          then now() + pg_catalog.make_interval(secs => greatest(1, coalesce(p_retry_delay_seconds, 30)))
        else available_at end,
      worker_id = null, locked_at = null, heartbeat_at = now(),
      cost_usd = cost_usd + greatest(coalesce(p_cost_usd, 0), 0),
      error_code = left(p_error_code, 100),
      error_message = left(p_error_message, 2000),
      completed_at = case
        when cancel_requested_at is not null or attempts >= max_attempts then now()
        else null end
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;
  if not found then return false; end if;

  perform private.add_cloud_lesson_cost(v_job.project_id, v_job.kind, p_cost_usd);

  if v_job.status = 'failed' then
    if v_job.scene_id is not null then
      update public.cloud_lesson_scenes
      set status = 'failed', error_message = left(p_error_message, 2000), completed_at = now()
      where id = v_job.scene_id;
    end if;
    -- A deck is a separate deliverable. Failing the lesson here would cancel
    -- the queued video work and mark a lesson failed that is, for the video
    -- the teacher also asked for, fine. The job row carries the failure and
    -- lesson_outputs_outstanding reports the deck as still missing.
    if v_job.kind <> 'deck' then
      perform private.fail_cloud_lesson(v_job.project_id, p_error_message);
    end if;
  end if;
  return true;
end;
$$;

comment on function public.fail_cloud_lesson_job is
  'Records a job failure: requeues with backoff while attempts remain, else '
  'marks it failed. A terminally failed deck does NOT fail its lesson -- the '
  'video is independent work the teacher keeps.';

revoke all on function public.fail_cloud_lesson_job(uuid, text, text, text, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.fail_cloud_lesson_job(uuid, text, text, text, integer, numeric)
  to service_role;

notify pgrst, 'reload schema';
