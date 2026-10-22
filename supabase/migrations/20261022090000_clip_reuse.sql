-- ─────────────────────────────────────────────────────────────────────────────
-- 20261022090000 · Don't re-animate a clip that already exists
--
-- The companion to 20261020180000. Keyframe reuse saves a diffusion run; this
-- saves a Wan run, which is the most expensive stage in the pipeline -- its
-- timeout is 1800s against 900s for a keyframe.
--
-- It returns the RAW clip, not the composed scene. Composition adds captions,
-- which are language-specific, so the raw motion is the part that is reusable
-- across languages. That is the same thing lesson-level reuse passes as
-- `reusedRawVideoUrl`.
--
-- Why this cannot reuse the lesson-level machinery, which already carries a
-- raw clip between projects: `media-worker.ts:113` requires
-- `job.parameters.reusedFromProjectId` to equal the project's own
-- `reused_from_project_id`, and requires that source to be `succeeded` and
-- owned by the caller. The case this function exists for is a source that
-- FAILED, so it can never be a legitimate `reused_from_project_id`. Forcing it
-- through that parameter would mean relaxing a validation that exists to stop
-- a worker being handed an arbitrary project's assets.
--
-- So the worker asks this function at run time instead, and scopes its
-- download to the project id returned here. The authorisation happens in one
-- place -- below -- rather than in a job parameter the worker would have to
-- re-verify.
--
-- Returns the source project id alongside the URL for exactly that reason: the
-- caller needs to know which project's storage path the bytes legitimately
-- live under.
--
-- Matching is stricter than for a keyframe, because a clip is a function of
-- more things:
--
--   video_prompt     the motion asked for
--   image_url        Wan animates a specific picture; a different keyframe
--                    gives a different clip even from the same prompt
--   motion_mode      'still' scenes never produce a raw clip at all
--   duration_seconds a 7.5s slot and a 10s slot are different clips
--
-- plus the same owner/school scope and the same style, model and curriculum
-- dimensions as keyframe reuse. Language is again not a dimension: raw motion
-- carries no words.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.cloud_lesson_reusable_clip(p_scene_id uuid)
returns table (raw_video_url text, source_project_id uuid)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_scene public.cloud_lesson_scenes;
  v_project public.cloud_lesson_projects;
begin
  select * into v_scene from public.cloud_lesson_scenes where id = p_scene_id;
  if not found then return; end if;

  select * into v_project from public.cloud_lesson_projects where id = v_scene.project_id;
  if not found then return; end if;

  -- A still scene is FFmpeg zoompan over an approved frame: seconds of CPU,
  -- no Wan run, and no raw clip to find. Answering for one would only invite
  -- a caller to reuse something that costs nothing to make.
  if v_scene.motion_mode <> 'animate' then return; end if;

  -- Without a keyframe there is nothing for a clip to have animated, so
  -- nothing to match on.
  if v_scene.image_url is null then return; end if;
  if coalesce(btrim(v_scene.video_prompt), '') = '' then return; end if;

  return query
  select
    j.output_metadata ->> 'rawVideoUrl',
    p.id
  from public.cloud_lesson_scenes s
  join public.cloud_lesson_projects p on p.id = s.project_id
  join public.cloud_lesson_jobs j on j.scene_id = s.id
  where s.id <> v_scene.id
    and s.video_prompt = v_scene.video_prompt
    -- The same picture. A clip is motion applied to one specific keyframe.
    and s.image_url = v_scene.image_url
    and s.motion_mode = 'animate'
    and s.duration_seconds = v_scene.duration_seconds
    and s.status = 'succeeded'
    and j.kind = 'video'
    and j.status = 'succeeded'
    -- The raw clip must actually be there and be an https URL. A job whose
    -- metadata lost it is not a source.
    and coalesce(j.output_metadata ->> 'rawVideoUrl', '') ~ '^https://'
    -- Same authorisation rule as reserve_cloud_lesson and
    -- cloud_lesson_reusable_keyframe: own work, or the school's.
    and (p.owner_id = v_project.owner_id
         or (v_project.school_id is not null and p.school_id = v_project.school_id))
    and p.visual_style = v_project.visual_style
    and p.generator_version = v_project.generator_version
    and p.curriculum_version = v_project.curriculum_version
    and p.status <> 'cancelled'
  order by (p.owner_id = v_project.owner_id) desc, s.completed_at desc nulls last
  limit 1;
end;
$$;

comment on function public.cloud_lesson_reusable_clip is
  'The raw Wan clip for this scene''s exact prompt AND keyframe, with the '
  'project it belongs to, within the caller''s own or their school''s work at '
  'the same style, model and curriculum version. Animate scenes only. Empty '
  'when there is none.';

revoke all on function public.cloud_lesson_reusable_clip(uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_lesson_reusable_clip(uuid) to service_role;

notify pgrst, 'reload schema';
