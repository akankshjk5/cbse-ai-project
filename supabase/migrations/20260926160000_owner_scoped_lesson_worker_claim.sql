-- A self-service lesson worker may process future requests for exactly one
-- authenticated owner. It must never claim another owner's lesson or deck jobs.
create or replace function public.claim_lesson_video_job_for_owner(
  p_worker_id text,
  p_owner_id text
)
returns setof public.lesson_video_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 3
     or p_owner_id is null or length(trim(p_owner_id)) < 3 then
    raise exception 'A worker id and owner id are required';
  end if;

  with recovered as (
    update public.lesson_video_jobs j
    set status = case when j.attempts < j.max_attempts then 'queued' else 'failed' end,
        available_at = case when j.attempts < j.max_attempts then now() else j.available_at end,
        worker_id = null, locked_at = null,
        error_code = 'worker_lost',
        error_message = 'Worker heartbeat expired; job recovered by queue.',
        completed_at = case when j.attempts >= j.max_attempts then now() else null end
    from public.lesson_video_projects p
    where j.project_id = p.id and p.owner_id = p_owner_id
      and p.status in ('generating_images', 'generating_videos', 'assembling')
      and j.status = 'processing'
      and coalesce(j.heartbeat_at, j.locked_at, j.started_at, j.created_at)
          < now() - interval '5 minutes'
    returning j.project_id, j.status, j.error_message
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
    select j.id
    from public.lesson_video_jobs j
    join public.lesson_video_projects p on p.id = j.project_id
    where p.owner_id = p_owner_id
      and p.status in ('generating_images', 'generating_videos', 'assembling')
      and j.status = 'queued' and j.available_at <= now()
      and j.cancel_requested_at is null and j.attempts < j.max_attempts
    order by j.created_at
    for update of j skip locked limit 1
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
  join public.lesson_video_projects p on p.id = j.project_id
  where j.scene_id = s.id and j.worker_id = p_worker_id
    and p.owner_id = p_owner_id and j.status = 'processing'
    and j.kind in ('image', 'video');
end;
$$;

revoke all on function public.claim_lesson_video_job_for_owner(text,text)
  from public, anon, authenticated;
grant execute on function public.claim_lesson_video_job_for_owner(text,text)
  to service_role;
