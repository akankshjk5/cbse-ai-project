-- Keep a standalone project's terminal state aligned when claim-time stale
-- worker recovery exhausts the job's final attempt.

create or replace function public.claim_deck_media_job(p_worker_id text)
returns setof public.deck_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  with recovered as (
    update public.deck_media_jobs
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        available_at = case when attempts < max_attempts then now() else available_at end,
        worker_id = null,
        locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when attempts >= max_attempts then now() else null end
    where status = 'processing'
      and coalesce(heartbeat_at, locked_at, started_at, created_at)
        < now() - interval '5 minutes'
    returning video_project_id, status, error_message
  )
  update public.video_projects p
  set status = 'failed',
      error_message = r.error_message,
      completed_at = now()
  from recovered r
  where r.video_project_id = p.id and r.status = 'failed';

  return query
  with candidate as (
    select id
    from public.deck_media_jobs
    where status = 'queued'
      and available_at <= now()
      and cancel_requested_at is null
      and attempts < max_attempts
    order by created_at
    for update skip locked
    limit 1
  )
  update public.deck_media_jobs j
  set status = 'processing',
      progress = greatest(j.progress, 1),
      attempts = j.attempts + 1,
      worker_id = p_worker_id,
      locked_at = now(),
      heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()),
      error_code = null,
      error_message = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;
