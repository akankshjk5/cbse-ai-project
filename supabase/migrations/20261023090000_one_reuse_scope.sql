-- ─────────────────────────────────────────────────────────────────────────────
-- 20261023090000 · One definition of who may reuse whose work
--
-- The rule "your own work, or anything your school already paid for" is spelled
-- out five times across four migrations:
--
--   20261014120000_school_scoped_reuse.sql:215   reserve_cloud_lesson
--   20261014120000_school_scoped_reuse.sql:298   complete_cloud_lesson_preparation
--   20261015120000_unified_reuse_and_cost.sql:229 reserve_cloud_lesson
--   20261020180000_keyframe_reuse.sql:82         cloud_lesson_reusable_keyframe
--   20261022090000_clip_reuse.sql:94             cloud_lesson_reusable_clip
--
-- Five copies of an authorisation rule is five chances for one to drift. The
-- failure would be quiet and in the worst direction: a copy that forgot the
-- `p_school is not null` guard would treat two schoolless teachers as
-- colleagues and reuse one's assets for the other.
--
-- This extracts it once and points the two newest functions at it. It does NOT
-- touch `reserve_cloud_lesson` or `complete_cloud_lesson_preparation`: both are
-- long, both have been redefined repeatedly, and reproducing them wholesale to
-- change one predicate would risk far more than it tidies. Their copies are
-- listed above so the next person to touch them knows where the canonical rule
-- lives, and `reuse_scope.sql` asserts all three agree on the same truth table.
--
-- `language sql` and `immutable` on purpose: PostgreSQL inlines a plain-SQL
-- function of scalar arguments into the calling query, so this stays a join
-- predicate the planner can work with rather than a per-row function call. A
-- plpgsql version would not inline and would turn an indexed lookup into a
-- scan.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.reuse_scope_ok(
  p_owner text,       -- the teacher asking
  p_school uuid,      -- their school, or null
  c_owner text,       -- the candidate asset's owner
  c_school uuid       -- the candidate's school, or null
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Own work always. A colleague's only when BOTH sides have the same, real
  -- school: without the null guard, two teachers who belong to no school would
  -- match each other, which is the leak this rule exists to prevent.
  select c_owner = p_owner
      or (p_school is not null and c_school = p_school)
$$;

comment on function private.reuse_scope_ok is
  'The one definition of reuse authorisation: the caller''s own work, or work '
  'belonging to the same non-null school. Inlinable, so it stays a join '
  'predicate. reserve_cloud_lesson and complete_cloud_lesson_preparation still '
  'inline their own copies; supabase/tests/reuse_scope.sql holds all of them to '
  'the same truth table.';

-- ── The two newest functions now call it ────────────────────────────────────
-- Reproduced from their own migrations with the predicate replaced and nothing
-- else changed.

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
  if not found then return null; end if;

  select * into v_project from public.cloud_lesson_projects where id = v_scene.project_id;
  if not found then return null; end if;

  -- An empty or absent prompt must never match another empty one: that would
  -- hand back an arbitrary picture for a scene whose prompt was lost.
  if coalesce(btrim(v_scene.image_prompt), '') = '' then return null; end if;

  select s.image_url into v_url
  from public.cloud_lesson_scenes s
  join public.cloud_lesson_projects p on p.id = s.project_id
  where s.id <> v_scene.id
    and s.image_prompt = v_scene.image_prompt
    and s.status = 'succeeded'
    and s.image_url is not null
    and private.reuse_scope_ok(v_project.owner_id, v_project.school_id, p.owner_id, p.school_id)
    and p.visual_style = v_project.visual_style
    and p.generator_version = v_project.generator_version
    and p.curriculum_version = v_project.curriculum_version
    -- A failed or cancelled-by-nobody lesson may still hold good keyframes --
    -- that is the case this function exists for -- so the SCENE's status is
    -- what matters. A lesson the teacher cancelled is excluded.
    and p.status <> 'cancelled'
  order by (p.owner_id = v_project.owner_id) desc, s.completed_at desc nulls last
  limit 1;

  return v_url;
end;
$$;

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

  -- A still scene is FFmpeg zoompan over an approved frame: seconds of CPU, no
  -- Wan run, and no raw clip to find.
  if v_scene.motion_mode <> 'animate' then return; end if;
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
    and coalesce(j.output_metadata ->> 'rawVideoUrl', '') ~ '^https://'
    and private.reuse_scope_ok(v_project.owner_id, v_project.school_id, p.owner_id, p.school_id)
    and p.visual_style = v_project.visual_style
    and p.generator_version = v_project.generator_version
    and p.curriculum_version = v_project.curriculum_version
    and p.status <> 'cancelled'
  order by (p.owner_id = v_project.owner_id) desc, s.completed_at desc nulls last
  limit 1;
end;
$$;

revoke all on function private.reuse_scope_ok(text, uuid, text, uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
