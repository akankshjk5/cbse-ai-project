-- ─────────────────────────────────────────────────────────────────────────────
-- 20261020150000 · A lesson cannot report success with an unfinished scene
--
-- `complete_cloud_lesson_job` ends its assemble branch with:
--
--     update public.cloud_lesson_projects
--     set status = 'succeeded', final_video_url = p_output_url, ...
--     where id = v_project.id;
--
-- unconditionally. Nothing re-checks the scenes. The only guard is at job
-- CREATION time -- the assemble job is inserted in the `video` branch, and
-- only once no scene is left unfinished -- so the invariant lives in one place
-- and the claim of success is made in another.
--
-- Driven directly against PostgreSQL 18.1, an assemble job completing beside a
-- scene still at `generating_video` produced:
--
--     status = succeeded, final_video_url = https://example.test/lesson.mp4
--
-- **Honest about reachability:** that state was constructed in SQL. I have not
-- demonstrated a production path that creates an assemble job while a scene is
-- unfinished, and the creation guard plus the early return on a failed or
-- cancelled project make it hard to reach. This is defence in depth, not a
-- reproduction of a bug seen in the wild.
--
-- It is still worth fixing, for one reason: of everything that can go wrong
-- here, a lesson that says `succeeded` and plays a video missing a scene is
-- the worst, because a teacher takes it into a classroom. A failure is
-- recoverable; a false success is shown to children. An invariant that decides
-- that should be checked where the claim is made.
--
-- Non-destructive by design. The assemble job is still recorded as succeeded,
-- because it did its work and the bytes exist; what is withheld is the
-- lesson-level claim. The project keeps its current status so the outstanding
-- scene work can finish, and the discrepancy is written to the job's
-- error_code so it is visible rather than merely absent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.complete_cloud_lesson_job(
  p_job_id uuid,
  p_worker_id text,
  p_output_url text,
  p_output_metadata jsonb default '{}'::jsonb,
  p_cost_usd numeric default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_video_negative constant text := 'text, writing, letters, numbers, captions, labels, logo, watermark, cuts, flicker, deformation, unstable geometry, frozen subject, static image, slideshow, camera-only motion';
  v_job public.cloud_lesson_jobs;
  v_project public.cloud_lesson_projects;
  v_scene public.cloud_lesson_scenes;
  v_unfinished int;
begin
  if p_output_url is null or p_output_url !~ '^https://' then
    raise exception 'Output URL must use HTTPS';
  end if;

  update public.cloud_lesson_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      cost_usd = greatest(coalesce(p_cost_usd, 0), 0),
      completed_at = now(), heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
    and kind in ('image', 'video', 'assemble')
  returning * into v_job;
  if not found then return false; end if;

  -- Money spent is money spent, cancelled or not.
  perform private.add_cloud_lesson_cost(v_job.project_id, v_job.kind, p_cost_usd);

  select * into v_project from public.cloud_lesson_projects
  where id = v_job.project_id for update;
  if v_job.status = 'cancelled' or v_project.status in ('cancelled', 'failed', 'succeeded') then
    return true;
  end if;

  if v_job.kind = 'image' then
    update public.cloud_lesson_scenes
    set image_url = p_output_url, status = 'queued_video', error_message = null
    where id = v_job.scene_id
    returning * into v_scene;

    insert into public.cloud_lesson_jobs (
      owner_id, project_id, scene_id, kind, prompt, negative_prompt,
      source_image_url, max_attempts, parameters
    ) values (
      v_project.owner_id, v_project.id, v_scene.id, 'video', v_scene.video_prompt, c_video_negative,
      p_output_url, 2,
      pg_catalog.jsonb_build_object(
        'sceneIndex', v_scene.scene_index,
        'motionMode', v_scene.motion_mode,
        'clipSeconds', 5,
        'slotSeconds', v_scene.duration_seconds
      )
    );

    if v_scene.scene_index = 1 then
      update public.cloud_lesson_jobs
      set available_at = now(),
          parameters = parameters
            || pg_catalog.jsonb_build_object('styleReferenceUrl', p_output_url, 'awaitsStyleReference', false)
      where project_id = v_project.id and kind = 'image' and status = 'queued'
        and available_at = 'infinity'::timestamptz;
    end if;

    if not exists (
      select 1 from public.cloud_lesson_scenes
      where project_id = v_project.id and image_url is null
    ) then
      update public.cloud_lesson_projects set status = 'generating_videos'
      where id = v_project.id and status = 'generating_images';
    end if;

  elsif v_job.kind = 'video' then
    update public.cloud_lesson_scenes
    set video_url = p_output_url, status = 'succeeded', error_message = null, completed_at = now()
    where id = v_job.scene_id;

    if not exists (
      select 1 from public.cloud_lesson_scenes
      where project_id = v_project.id and status <> 'succeeded'
    ) then
      insert into public.cloud_lesson_jobs (owner_id, project_id, kind, max_attempts, parameters)
      values (
        v_project.owner_id, v_project.id, 'assemble', 2,
        pg_catalog.jsonb_build_object('targetDurationSeconds', v_project.target_duration_seconds)
      ) on conflict (project_id) where kind = 'assemble' do nothing;
      update public.cloud_lesson_projects set status = 'assembling' where id = v_project.id;
    end if;

  else
    -- The check this migration adds. Counted here, at the moment success is
    -- claimed, rather than trusted from the creation-time guard in the branch
    -- above.
    select count(*) into v_unfinished
    from public.cloud_lesson_scenes
    where project_id = v_project.id and status <> 'succeeded';

    if v_unfinished > 0 then
      -- The job did its work, so it keeps its 'succeeded' status and its
      -- output_url. What is withheld is the LESSON-level claim. The project
      -- keeps its current status so the outstanding scenes can still finish,
      -- and the reason is recorded where someone will find it.
      update public.cloud_lesson_jobs
      set error_code = 'assembled_with_unfinished_scenes',
          error_message = pg_catalog.format(
            'Assembly finished while %s scene(s) were not succeeded. The lesson '
            'was NOT marked succeeded: a video missing a scene must not be '
            'presented as a finished lesson.', v_unfinished)
      where id = v_job.id;
      return true;
    end if;

    update public.cloud_lesson_projects
    set status = 'succeeded', final_video_url = p_output_url, error_message = null, completed_at = now()
    where id = v_project.id;
  end if;

  return true;
end;
$$;

comment on function public.complete_cloud_lesson_job is
  'Records a finished job. The assemble branch promotes the lesson to '
  'succeeded ONLY when every scene has succeeded; otherwise the job is kept '
  'as succeeded, the lesson is left alone, and the job carries '
  'error_code = assembled_with_unfinished_scenes.';

revoke all on function public.complete_cloud_lesson_job(uuid, text, text, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function public.complete_cloud_lesson_job(uuid, text, text, jsonb, numeric)
  to service_role;

notify pgrst, 'reload schema';
