-- ─────────────────────────────────────────────────────────────────────────────
-- 20261020180000 · Don't regenerate a keyframe that already exists
--
-- Lesson-level reuse requires the SOURCE LESSON to have succeeded in full:
-- `reserve_cloud_lesson` only considers a candidate with
-- `p.status = 'succeeded'`, an audited source plan, and every scene ready.
--
-- So the case it cannot help is the common one. A lesson that fails partway is
-- a total loss of GPU work: video_lifecycle.sql property 4 shows that one scene
-- out of retries fails the whole lesson and cancels its queued jobs, and the
-- failed project is then not a reusable source. The teacher clicks again, and
-- every keyframe that had already succeeded is generated from scratch.
--
-- For a 60-second lesson that is up to 8 keyframes, each a full diffusion run,
-- redone because one of them ran out of memory.
--
-- This adds a lookup for one keyframe rather than one lesson. It introduces no
-- new table and no new cache to invalidate: the answer is already in
-- `cloud_lesson_scenes`, which holds the prompt that produced each image and
-- the URL it produced.
--
-- The authorisation rule is copied from `reserve_cloud_lesson`, deliberately
-- and exactly: the caller's own work, or anything their school already paid
-- for. A keyframe is a generated asset of a lesson, so reusing one across a
-- boundary that lesson-level reuse refuses to cross would be a quieter version
-- of the same leak.
--
-- The same dimensions invalidate it, for the same reasons:
--   visual_style       a different style is a different picture
--   generator_version  an older model's output must not be served as this one's
--   curriculum_version a superseded syllabus is not reusable
--   language_code      NOT included: a keyframe carries no words. This is the
--                      whole point of the `rebuild` disposition, which keeps
--                      visuals and pays only for voice and assembly.
--
-- What it will NOT return:
--   * an image from a scene that did not succeed
--   * an image from a scene with no URL
--   * an image whose prompt differs in any way, including whitespace
--   * the scene's own image, so a retry cannot reuse the thing it is retrying
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.cloud_lesson_reusable_keyframe(p_scene_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_scene public.cloud_lesson_scenes;
  v_project public.cloud_lesson_projects;
  v_url text;
begin
  select * into v_scene from public.cloud_lesson_scenes where id = p_scene_id;
  if not found then
    return null;
  end if;

  select * into v_project from public.cloud_lesson_projects where id = v_scene.project_id;
  if not found then
    return null;
  end if;

  -- An empty or absent prompt must never match another empty one: that would
  -- hand back an arbitrary picture for a scene whose prompt was lost.
  if coalesce(btrim(v_scene.image_prompt), '') = '' then
    return null;
  end if;

  select s.image_url into v_url
  from public.cloud_lesson_scenes s
  join public.cloud_lesson_projects p on p.id = s.project_id
  where s.id <> v_scene.id
    and s.image_prompt = v_scene.image_prompt
    and s.status = 'succeeded'
    and s.image_url is not null
    -- Same authorisation rule as reserve_cloud_lesson: own work, or the
    -- school's. Not clerk_user_id(): a worker runs as the service role, so
    -- the owner is taken from the lesson being generated.
    and (p.owner_id = v_project.owner_id
         or (v_project.school_id is not null and p.school_id = v_project.school_id))
    and p.visual_style = v_project.visual_style
    and p.generator_version = v_project.generator_version
    and p.curriculum_version = v_project.curriculum_version
    -- A lesson the teacher cancelled or that failed may still hold perfectly
    -- good keyframes -- that is the case this function exists for -- so the
    -- SCENE's status is what matters, not the project's. Excluded only if the
    -- project was never a legitimate generation.
    and p.status <> 'cancelled'
  -- The caller's own work first, then the most recent: a teacher reuses their
  -- own picture before a colleague's, matching reserve_cloud_lesson's tie-break.
  order by (p.owner_id = v_project.owner_id) desc, s.completed_at desc nulls last
  limit 1;

  return v_url;
end;
$$;

comment on function public.cloud_lesson_reusable_keyframe is
  'An existing keyframe for this scene''s exact prompt, within the caller''s own '
  'or their school''s work, at the same style, model and curriculum version. '
  'NULL when there is none. Language is deliberately not a dimension: a '
  'keyframe carries no words.';

revoke all on function public.cloud_lesson_reusable_keyframe(uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_lesson_reusable_keyframe(uuid) to service_role;

notify pgrst, 'reload schema';
