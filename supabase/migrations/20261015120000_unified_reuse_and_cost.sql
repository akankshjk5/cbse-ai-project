-- Unified reuse dimensions, asset provenance and per-stage cost accounting.
--
-- Three things, all on the lesson/job schema that both execution paths share,
-- so there is one reuse implementation rather than one per pipeline.
--
-- 1. The reuse key gains the two dimensions it still lacked: the lesson
--    schema's own version, and the model identity per stage. Without them a
--    lesson made by a retired model is reused forever, and swapping an image
--    model silently keeps serving the old one's output.
--
-- 2. Scenes carry provenance. A reused picture records which lesson, scene,
--    model and pipeline produced it, so a bad asset can be recalled across
--    every lesson that borrowed it rather than only the one that made it.
--
-- 3. Jobs record what they actually consumed — GPU type and seconds, CPU
--    seconds, peak memory — and on what basis the money figure rests.
--    `cost_basis` is a column rather than a key in output_metadata because the
--    difference between a measured bill and a rate we chose is the single most
--    important fact about a cost, and it should not be optional to record.
--
-- Unpriced is not free. A stage with no usage data stores NULL in cost_usd and
-- 'unpriced' in cost_basis; a report that wants one number has to decide what
-- to do about it, which is the correct burden.

-- ── Reuse dimensions ────────────────────────────────────────────────────────

alter table public.cloud_lesson_projects
  -- The lesson schema's shape. Bump when scenes gain or lose a field.
  add column if not exists content_version text not null default 'lesson.v1'
    check (char_length(btrim(content_version)) between 2 and 40),
  -- Model identity per stage: {"plan":"qwen3-4b","image":"z-image-turbo",...}.
  -- Compared whole, so changing any one stage's model retires the lesson.
  add column if not exists model_versions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(model_versions) = 'object'),
  -- The ceiling this lesson may spend, enforced before the expensive stages.
  -- Null means the deployment default applies.
  add column if not exists budget_usd numeric(10,4)
    check (budget_usd is null or budget_usd > 0);

comment on column public.cloud_lesson_projects.model_versions is
  'Per-stage model identity. Part of the reuse key: a lesson is reusable only '
  'by a request whose models match exactly, so swapping a model retires its output.';

-- The canonical model set for new lessons. One function, so changing a model
-- is a migration rather than a redeploy, and every lesson records what it used.
create or replace function private.cloud_lesson_model_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'plan', 'qwen3-4b',
    'image', 'z-image-turbo-bf16',
    'speech', 'indic-parler-tts',
    'motion', 'wan-2.2-ti2v-5b-fp16',
    'vision', 'qwen2.5-vl-7b'
  )
$$;
revoke all on function private.cloud_lesson_model_versions()
  from public, anon, authenticated, service_role;

-- ── Asset provenance ────────────────────────────────────────────────────────

alter table public.cloud_lesson_scenes
  add column if not exists asset_provenance jsonb not null default '[]'::jsonb
    check (jsonb_typeof(asset_provenance) = 'array');

comment on column public.cloud_lesson_scenes.asset_provenance is
  'Append-only record of where a reused asset came from: source lesson, source '
  'scene, stage, model version, pipeline version, timestamp. Empty when the '
  'scene generated its own assets.';

create index if not exists cloud_lesson_scene_provenance_idx
  on public.cloud_lesson_scenes using gin (asset_provenance)
  where asset_provenance <> '[]'::jsonb;

-- ── Cost accounting ─────────────────────────────────────────────────────────

alter table public.cloud_lesson_jobs
  add column if not exists provider_id text
    check (provider_id is null or char_length(provider_id) between 2 and 60),
  add column if not exists model_id text
    check (model_id is null or char_length(model_id) between 1 and 120),
  -- measured  the provider reported usage we were billed on
  -- estimated derived from runtime and an hourly rate we chose
  -- unpriced  no usage data; NOT the same as free
  add column if not exists cost_basis text not null default 'unpriced'
    check (cost_basis in ('measured', 'estimated', 'unpriced')),
  add column if not exists gpu_type text
    check (gpu_type is null or char_length(gpu_type) between 2 and 60),
  add column if not exists gpu_seconds numeric(10,3)
    check (gpu_seconds is null or gpu_seconds >= 0),
  add column if not exists cpu_seconds numeric(10,3)
    check (cpu_seconds is null or cpu_seconds >= 0),
  add column if not exists peak_memory_mb integer
    check (peak_memory_mb is null or peak_memory_mb >= 0);

-- An unpriced job must not carry a cost, and a priced one must carry a basis
-- that explains it. Without this a zero can mean "free" or "we did not look".
alter table public.cloud_lesson_jobs
  drop constraint if exists cloud_lesson_jobs_cost_basis_agrees;
alter table public.cloud_lesson_jobs
  add constraint cloud_lesson_jobs_cost_basis_agrees
  check (cost_basis <> 'unpriced' or cost_usd = 0);

create index if not exists cloud_lesson_jobs_cost_idx
  on public.cloud_lesson_jobs (project_id, kind, status);

-- What a lesson consumed, by stage, with the bases kept apart. Reads only
-- rows the caller can already see, so it inherits the jobs table's RLS.
create or replace view public.cloud_lesson_stage_costs as
select
  j.project_id,
  j.kind as stage,
  count(*) as attempts,
  count(*) filter (where j.status = 'succeeded') as succeeded,
  count(*) filter (where j.attempts > 1) as retried,
  coalesce(sum(j.cost_usd) filter (where j.cost_basis = 'measured' and j.status = 'succeeded'), 0) as measured_usd,
  coalesce(sum(j.cost_usd) filter (where j.cost_basis = 'estimated' and j.status = 'succeeded'), 0) as estimated_usd,
  count(*) filter (where j.cost_basis = 'unpriced') as unpriced_jobs,
  coalesce(sum(j.cost_usd) filter (where j.status <> 'succeeded'), 0) as wasted_usd,
  coalesce(sum(j.gpu_seconds), 0) as gpu_seconds,
  coalesce(sum(j.cpu_seconds), 0) as cpu_seconds,
  max(j.peak_memory_mb) as peak_memory_mb,
  count(distinct j.provider_request_id) filter (where j.provider_request_id is not null) as paid_requests
from public.cloud_lesson_jobs j
group by j.project_id, j.kind;

revoke all on public.cloud_lesson_stage_costs from anon;
grant select on public.cloud_lesson_stage_costs to authenticated, service_role;

-- Whether a lesson's stored total agrees with the sum of its jobs. A crash
-- between a job write and the lesson update leaves them disagreeing, and that
-- is otherwise invisible.
create or replace function public.cloud_lesson_cost_reconciliation(p_project_id uuid)
returns table (recorded_usd numeric, computed_usd numeric, difference_usd numeric, agrees boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.cost_usd,
    coalesce(c.total, 0),
    abs(p.cost_usd - coalesce(c.total, 0)),
    abs(p.cost_usd - coalesce(c.total, 0)) <= 0.0001
  from public.cloud_lesson_projects p
  left join (
    select s.project_id, sum(s.measured_usd + s.estimated_usd) as total
    from public.cloud_lesson_stage_costs s
    where s.project_id = p_project_id
    group by s.project_id
  ) c on c.project_id = p.id
  where p.id = p_project_id
    and (p.owner_id = public.clerk_user_id()
      or (p.school_id is not null and p.school_id = public.current_school_id()));
$$;
revoke all on function public.cloud_lesson_cost_reconciliation(uuid) from public, anon;
grant execute on function public.cloud_lesson_cost_reconciliation(uuid) to authenticated, service_role;

-- ── Reservation: the two new dimensions join the reuse match ────────────────
-- Same body and the same advisory lock as 20261014120000 — the lock is what
-- makes two simultaneous requests for one lesson safe, and it is unchanged.
-- Only the compatibility predicate grows.

drop function if exists public.reserve_cloud_lesson(smallint, text, text, text, smallint, text, text, text);

create function public.reserve_cloud_lesson(
  p_class_level smallint, p_subject text, p_topic text, p_language_code text,
  p_target_duration_seconds smallint default 60, p_visual_style text default 'illustrated',
  p_chapter text default null, p_difficulty text default 'standard'
) returns setof public.cloud_lesson_projects
language plpgsql security definer set search_path = '' as $$
declare
  v_owner text := public.clerk_user_id();
  v_school uuid;
  v_key text;
  v_curriculum text := 'NCERT-2023';
  v_content text := 'lesson.v1';
  v_generator text := private.cloud_lesson_generator_version();
  v_models jsonb := private.cloud_lesson_model_versions();
  v_chapter text := nullif(btrim(coalesce(p_chapter, '')), '');
  v_project public.cloud_lesson_projects;
  v_source public.cloud_lesson_projects;
begin
  if v_owner is null then
    raise exception 'Sign in to generate a lesson.' using hint = 'cloud_lesson_auth';
  end if;
  if p_class_level is null or p_class_level not between 1 and 12
    or char_length(btrim(coalesce(p_subject, ''))) not between 2 and 100
    or char_length(btrim(coalesce(p_topic, ''))) not between 3 and 300
    or p_language_code is null or p_language_code not in ('en-IN', 'hi-IN', 'kn-IN')
    or p_target_duration_seconds is null or p_target_duration_seconds not in (30, 60)
    or p_visual_style is null or p_visual_style not in ('illustrated', 'editorial', 'storybook')
    or p_difficulty is null or p_difficulty not in ('foundational', 'standard', 'advanced')
    or (v_chapter is not null and char_length(v_chapter) > 200) then
    raise exception 'Check the class, subject, topic and language.' using hint = 'cloud_lesson_invalid';
  end if;

  v_school := public.current_school_id();

  -- One reservation per owner at a time. Two simultaneous requests for the same
  -- lesson serialise here, so the second sees the first's row and reuses it
  -- instead of starting a duplicate generation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cloud_lesson_reserve:' || v_owner, 0)
  );
  v_key := p_class_level::text || '|' || lower(regexp_replace(btrim(p_subject), '\s+', ' ', 'g'))
    || '|' || lower(regexp_replace(btrim(p_topic), '\s+', ' ', 'g'))
    || '|' || p_target_duration_seconds::text;

  -- An exact repeat, including work already in flight, needs no new job.
  select * into v_project from public.cloud_lesson_projects
  where owner_id = v_owner and content_key = v_key and visual_style = p_visual_style
    and language_code = p_language_code and curriculum_version = v_curriculum
    and generator_version = v_generator and content_version = v_content
    and model_versions = v_models
    and difficulty = p_difficulty and chapter is not distinct from v_chapter
    and status in ('succeeded', 'preparing', 'generating_images', 'generating_videos', 'assembling')
  order by (status = 'succeeded') desc, created_at desc limit 1;
  if found then return next v_project; return; end if;

  -- A reusable source must be the caller's or their school's, must match every
  -- dimension, and must be validated: finished, audited plan, every scene
  -- succeeded with a picture, every animated scene backed by a real clip.
  select p.* into v_source from public.cloud_lesson_projects p
  where
    (p.owner_id = v_owner or (v_school is not null and p.school_id = v_school))
    and p.content_key = v_key and p.visual_style = p_visual_style
    and p.language_code = p_language_code
    and p.curriculum_version = v_curriculum and p.generator_version = v_generator
    and p.content_version = v_content and p.model_versions = v_models
    and p.difficulty = p_difficulty and p.chapter is not distinct from v_chapter
    and p.status = 'succeeded' and p.completed_at is not null
    and p.reused_from_project_id is null
    and exists (
      select 1 from public.cloud_lesson_jobs j
      where j.project_id = p.id and j.kind = 'prepare' and j.status = 'succeeded'
        and jsonb_typeof(j.output_metadata -> 'sourcePlan') = 'object'
    )
    and (
      select pg_catalog.count(*) from public.cloud_lesson_scenes s
      where s.project_id = p.id and s.status = 'succeeded' and s.image_url is not null
    ) = p_target_duration_seconds / 7.5
    and not exists (
      select 1 from public.cloud_lesson_scenes s
      where s.project_id = p.id and s.motion_mode = 'animate'
        and not exists (
          select 1 from public.cloud_lesson_jobs j
          where j.scene_id = s.id and j.kind = 'video' and j.status = 'succeeded'
            and coalesce(j.output_metadata ->> 'rawVideoUrl', '') ~ '^https://'
        )
    )
    and not exists (
      select 1 from public.cloud_lesson_shots t where t.project_id = p.id and t.image_url is null
    )
  order by (p.owner_id = v_owner) desc, p.completed_at desc limit 1;

  select * into v_project from private.reserve_cloud_lesson_uncached(
    p_class_level, p_subject, p_topic, p_language_code, p_target_duration_seconds);
  update public.cloud_lesson_projects
  set visual_style = p_visual_style, school_id = v_school, chapter = v_chapter,
      difficulty = p_difficulty, curriculum_version = v_curriculum,
      generator_version = v_generator, content_version = v_content, model_versions = v_models
  where id = v_project.id returning * into v_project;
  update public.cloud_lesson_jobs
  set parameters = parameters || jsonb_build_object('visualStyle', p_visual_style)
  where project_id = v_project.id and kind = 'prepare';
  if v_source.id is not null then
    update public.cloud_lesson_projects set reused_from_project_id = v_source.id
    where id = v_project.id returning * into v_project;
  end if;
  return next v_project;
end; $$;
revoke all on function public.reserve_cloud_lesson(smallint, text, text, text, smallint, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_cloud_lesson(smallint, text, text, text, smallint, text, text, text)
  to authenticated;
