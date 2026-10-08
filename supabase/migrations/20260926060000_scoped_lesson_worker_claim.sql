-- Acceptance workers may process only explicitly requested lesson projects.
-- Unlike the generic claim function, recovery and claiming are both scoped.
create or replace function public.claim_lesson_video_job_for_projects(
  p_worker_id text,
  p_project_ids uuid[]
)
returns setof public.lesson_video_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 3
     or p_project_ids is null or cardinality(p_project_ids) < 1
     or cardinality(p_project_ids) > 10 then
    raise exception 'A worker id and one to ten project ids are required';
  end if;

  with recovered as (
    update public.lesson_video_jobs
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        available_at = case when attempts < max_attempts then now() else available_at end,
        worker_id = null, locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when attempts >= max_attempts then now() else null end
    where project_id = any(p_project_ids)
      and status = 'processing'
      and coalesce(heartbeat_at, locked_at, started_at, created_at) < now() - interval '5 minutes'
    returning project_id, status, error_message
  ), failed_projects as (
    update public.lesson_video_projects p
    set status = 'failed', error_message = r.error_message, completed_at = now()
    from recovered r where r.project_id = p.id and r.status = 'failed'
    returning p.id
  )
  update public.lesson_video_jobs j
  set status = 'cancelled', cancel_requested_at = now(), completed_at = now()
  from failed_projects p
  where j.project_id = p.id and j.status = 'queued';

  return query
  with candidate as (
    select id from public.lesson_video_jobs
    where project_id = any(p_project_ids)
      and status = 'queued' and available_at <= now()
      and cancel_requested_at is null and attempts < max_attempts
    order by created_at
    for update skip locked limit 1
  )
  update public.lesson_video_jobs j
  set status = 'processing', progress = greatest(j.progress, 1),
      attempts = j.attempts + 1, worker_id = p_worker_id,
      locked_at = now(), heartbeat_at = now(),
      started_at = coalesce(j.started_at, now()), error_code = null, error_message = null
  from candidate where j.id = candidate.id
  returning j.*;

  update public.lesson_video_scenes s
  set status = case j.kind when 'image' then 'generating_image' else 'generating_video' end
  from public.lesson_video_jobs j
  where j.scene_id = s.id and j.worker_id = p_worker_id
    and j.project_id = any(p_project_ids)
    and j.status = 'processing' and j.kind in ('image', 'video');
end;
$$;

revoke all on function public.claim_lesson_video_job_for_projects(text,uuid[])
  from public, anon, authenticated;
grant execute on function public.claim_lesson_video_job_for_projects(text,uuid[])
  to service_role;
