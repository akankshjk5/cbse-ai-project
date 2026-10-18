-- Finalising an asset, recording a reuse, and recovering from a bad object.
--
-- 20261018090000 gave assets a checksum and a `ready` state the database will
-- not grant without one. It did not say who may grant it, or how. Left to
-- application code, "upload then mark ready" is two statements with a window
-- between them, and every failure in that window leaves a lesson that looks
-- complete and is not: a row pointing at a half-written object, or an object
-- with no row at all.
--
-- These functions close the window. Finalisation is one statement that either
-- records a verified object or refuses, and publication reads from the same
-- place rather than from a flag someone remembered to set.

-- ── 1. Tighten the functions added last migration ───────────────────────────
-- `search_path=public, pg_temp` is adequate but not what the cloud_lesson
-- family uses. Those pin `search_path=''` and qualify every name, so a
-- temporary object cannot shadow anything a definer-rights function resolves.
-- Both functions below already qualify, so the stricter setting costs nothing.

create or replace function public.lesson_outputs_ready(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.cloud_lesson_projects p
    cross join unnest(p.requested_outputs) as wanted(kind)
    where p.id = p_project_id
      and not exists (
        select 1 from public.lesson_assets a
        where a.project_id = p.id
          and a.kind::text = wanted.kind::text
          and a.status = 'ready'
      )
  ) and exists (select 1 from public.cloud_lesson_projects where id = p_project_id);
$$;

create or replace function public.lesson_available_outputs(p_project_id uuid)
returns public.lesson_output_kind[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct a.kind::text::public.lesson_output_kind), '{}')
  from public.lesson_assets a
  where a.project_id = p_project_id
    and a.status = 'ready'
    and a.kind::text in ('video', 'pptx');
$$;

-- ── 2. Finalising an upload ─────────────────────────────────────────────────

create or replace function public.finalize_lesson_asset(
  p_project_id uuid,
  p_kind public.lesson_asset_kind,
  p_storage_bucket text,
  p_storage_key text,
  p_checksum_sha256 text,
  p_byte_size bigint,
  p_mime_type text,
  p_language_code text default null,
  p_scene_index smallint default null,
  p_cache_key text default null
)
returns public.lesson_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.lesson_assets;
  v_row public.lesson_assets;
begin
  -- The caller has already uploaded the object and computed the checksum over
  -- what the store returned. Everything below is about recording that fact
  -- exactly once.
  if p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'checksum must be 64 hex characters' using errcode = 'check_violation';
  end if;
  if p_byte_size is null or p_byte_size <= 0 then
    raise exception 'byte size must be positive' using errcode = 'check_violation';
  end if;

  -- Serialise finalisation of this one logical asset. Two workers that both
  -- finished the same upload must not each insert a version; the second has to
  -- see the first's row and recognise its own work.
  perform pg_advisory_xact_lock(
    hashtext(p_project_id::text || p_kind::text
             || coalesce(p_language_code, '') || coalesce(p_scene_index::text, '')));

  select * into v_existing from public.lesson_assets a
  where a.project_id = p_project_id
    and a.kind = p_kind
    and a.language_code is not distinct from p_language_code
    and a.scene_index is not distinct from p_scene_index
  order by a.version desc
  limit 1;

  -- Idempotent retry: the same bytes finalised twice is the same asset, not a
  -- new version. A worker that died after uploading and before committing will
  -- re-run and land here.
  if v_existing.id is not null
     and v_existing.checksum_sha256 = p_checksum_sha256
     and v_existing.status = 'ready' then
    return v_existing;
  end if;

  insert into public.lesson_assets (
    project_id, kind, language_code, scene_index, storage_bucket, storage_key,
    checksum_sha256, byte_size, mime_type, cache_key, status, validated_at,
    version, failure_reason
  ) values (
    p_project_id, p_kind, p_language_code, p_scene_index, p_storage_bucket,
    p_storage_key, p_checksum_sha256, p_byte_size, p_mime_type, p_cache_key,
    'ready', now(),
    -- Different bytes for the same logical asset is a regeneration, so the
    -- earlier row stays readable instead of being overwritten.
    coalesce(v_existing.version, 0) + 1, null
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.finalize_lesson_asset is
  'Records a verified object as ready, in one statement. Re-finalising the same '
  'checksum returns the existing row, so a retried upload does not create a '
  'second version.';

-- ── 3. Recovery ─────────────────────────────────────────────────────────────

create or replace function public.mark_lesson_asset_unusable(
  p_asset_id uuid,
  p_status public.lesson_asset_status,
  p_reason text
)
returns public.lesson_assets
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.lesson_assets;
begin
  if p_status not in ('missing', 'corrupt', 'failed') then
    raise exception 'only missing, corrupt or failed may be set here'
      using errcode = 'check_violation';
  end if;
  -- The checksum and size are deliberately left in place. They are the evidence
  -- of what the object was supposed to be, and a recovery job needs them to
  -- tell "the file changed" from "the file was never written".
  update public.lesson_assets
  set status = p_status,
      failure_reason = left(coalesce(p_reason, ''), 400),
      validated_at = null
  where id = p_asset_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such asset: %', p_asset_id using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

-- Which outputs a project still needs. A recovery job regenerates these and
-- nothing else: an unusable deck does not cost the video its keyframes.
create or replace function public.lesson_outputs_outstanding(p_project_id uuid)
returns public.lesson_output_kind[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct wanted.kind), '{}')
  from public.cloud_lesson_projects p
  cross join unnest(p.requested_outputs) as wanted(kind)
  where p.id = p_project_id
    and not exists (
      select 1 from public.lesson_assets a
      where a.project_id = p.id
        and a.kind::text = wanted.kind::text
        and a.status = 'ready'
    );
$$;

comment on function public.lesson_outputs_outstanding is
  'Requested outputs with no validated asset. The regeneration list after a '
  'corrupt or missing object is found.';

-- ── 4. Recording a reuse ────────────────────────────────────────────────────

create or replace function public.record_lesson_reuse(
  p_project_id uuid,
  p_source_project_id uuid,
  p_decision public.lesson_reuse_decision,
  p_satisfied public.lesson_output_kind[],
  p_generated public.lesson_output_kind[],
  p_reused_asset_ids uuid[],
  p_savings_usd numeric,
  p_savings_basis public.cost_basis,
  p_savings_gpu_seconds numeric,
  p_rationale text
)
returns public.lesson_reuse_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_school uuid;
  v_row public.lesson_reuse_events;
begin
  -- The requesting teacher is read from the project rather than taken as an
  -- argument. An audit row whose subject the caller can choose is not an audit
  -- row.
  select p.owner_id, p.school_id into v_owner, v_school
  from public.cloud_lesson_projects p where p.id = p_project_id;
  if v_owner is null then
    raise exception 'no such project: %', p_project_id using errcode = 'no_data_found';
  end if;

  insert into public.lesson_reuse_events (
    requested_by, project_id, source_project_id, school_id, decision,
    satisfied_outputs, generated_outputs, reused_asset_ids,
    savings_usd, savings_basis, savings_gpu_seconds, rationale
  ) values (
    v_owner, p_project_id, p_source_project_id, v_school, p_decision,
    coalesce(p_satisfied, '{}'), coalesce(p_generated, '{}'),
    coalesce(p_reused_asset_ids, '{}'),
    p_savings_usd, coalesce(p_savings_basis, 'unknown'), p_savings_gpu_seconds,
    left(coalesce(p_rationale, ''), 600)
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- ── 5. Publication ──────────────────────────────────────────────────────────

create or replace function public.publish_cloud_lesson(p_project_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_ready boolean;
begin
  -- One gate, read from the assets themselves. Earlier the status column was
  -- the only signal, which meant a lesson could be `succeeded` while its video
  -- was a half-written object — the row knew the pipeline finished, not that
  -- the file was there.
  select public.lesson_outputs_ready(p_project_id) into v_ready;
  if not v_ready then
    return false;
  end if;
  update public.cloud_lesson_projects
  set status = 'succeeded', completed_at = coalesce(completed_at, now())
  where id = p_project_id and status <> 'succeeded';
  return true;
end;
$$;

comment on function public.publish_cloud_lesson(uuid) is
  'Marks a lesson complete only when every requested output has a verified '
  'object. The single gate before a lesson becomes visible or reusable.';

revoke all on function public.finalize_lesson_asset(
  uuid, public.lesson_asset_kind, text, text, text, bigint, text, text, smallint, text)
  from public, anon, authenticated;
revoke all on function public.mark_lesson_asset_unusable(uuid, public.lesson_asset_status, text)
  from public, anon, authenticated;
revoke all on function public.record_lesson_reuse(
  uuid, uuid, public.lesson_reuse_decision, public.lesson_output_kind[],
  public.lesson_output_kind[], uuid[], numeric, public.cost_basis, numeric, text)
  from public, anon, authenticated;
revoke all on function public.publish_cloud_lesson(uuid) from public, anon, authenticated;
