-- Shared asset reuse: an audit trail, per-output tracking, and asset integrity.
--
-- School-scoped reuse already works: `reserve_cloud_lesson` matches a request
-- against `content_key` within the caller's school and copies the visuals. Three
-- things it cannot express yet, each of which this migration adds.
--
-- 1. WHAT WAS AVOIDED. Reuse leaves only `reused_from_project_id`, a pointer.
--    It cannot answer who asked, when, what was matched, or what the reuse
--    saved — and a saving quoted without saying whether it was measured or
--    guessed is the kind of number that ends up in a tender document as fact.
--
-- 2. WHICH OUTPUT. A lesson row carries one `final_video_url`. A teacher who
--    wants only a deck cannot say so, and a teacher who has a video but needs a
--    deck has no way to ask for the deck alone. Outputs become first-class, so
--    "reuse the video, build the missing PPTX" is representable.
--
-- 3. WHETHER THE FILE IS STILL THERE. A URL in a column is not evidence that an
--    object exists, is complete, or is the one that was validated. Without a
--    checksum, a truncated upload is indistinguishable from a good one until a
--    teacher plays it in front of a class.
--
-- Deliberately NOT changed: the reservation path. `reserve_cloud_lesson` and its
-- unique `(school_id, content_key)` index are what make concurrent identical
-- requests collapse into one job, and that is verified behaviour. Everything
-- here hangs off it rather than replacing it.

-- ── 1. Requested outputs ────────────────────────────────────────────────────
-- Which artefacts the teacher actually asked for. A column rather than a
-- separate table: it is a property of the request, it is always read with the
-- project, and it has exactly two possible members today.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lesson_output_kind') then
    create type public.lesson_output_kind as enum ('video', 'pptx');
  end if;
end $$;

alter table public.cloud_lesson_projects
  add column if not exists requested_outputs public.lesson_output_kind[]
    not null default array['video']::public.lesson_output_kind[];

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cloud_lesson_projects_requested_outputs_check'
  ) then
    alter table public.cloud_lesson_projects
      add constraint cloud_lesson_projects_requested_outputs_check
      -- At least one output, no duplicates. An empty request is a bug upstream,
      -- and a duplicate makes "is this output satisfied" ambiguous.
      --
      -- `cardinality`, not `array_length`: the latter returns NULL for an empty
      -- array, and a CHECK constraint accepts NULL, so `array_length(x,1)
      -- between 1 and 2` lets `'{}'` straight through. `cardinality('{}')` is 0,
      -- which fails as intended.
      --
      -- Written elementwise rather than with `count(distinct ...)` because a
      -- CHECK may not contain a subquery. With at most two members there is one
      -- pair to compare, so the direct form is exact.
      check (
        cardinality(requested_outputs) between 1 and 2
        and (cardinality(requested_outputs) = 1
             or requested_outputs[1] <> requested_outputs[2])
      );
  end if;
end $$;

comment on column public.cloud_lesson_projects.requested_outputs is
  'What the teacher asked for. Reuse satisfies these independently: an existing '
  'compatible video can serve a video-only request without any deck being built.';

-- ── 2. Assets ───────────────────────────────────────────────────────────────
-- One row per stored object. Binaries stay in Supabase Storage; this table holds
-- the identity, the integrity data and the state, so a lesson can be checked
-- without downloading anything.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lesson_asset_kind') then
    create type public.lesson_asset_kind as enum
      ('video', 'pptx', 'keyframe', 'clip', 'narration', 'subtitle');
  end if;
  if not exists (select 1 from pg_type where typname = 'lesson_asset_status') then
    -- `missing` and `corrupt` are distinct on purpose: a vanished object may be
    -- a storage incident to investigate, while a checksum mismatch means the
    -- bytes changed under us and the output must be rebuilt.
    create type public.lesson_asset_status as enum
      ('pending', 'uploading', 'ready', 'failed', 'missing', 'corrupt');
  end if;
end $$;

create table if not exists public.lesson_assets (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  kind public.lesson_asset_kind not null,
  -- Null for artefacts that carry no language: a keyframe and a motion clip are
  -- shared across every language of the same lesson, which is what makes a
  -- Kannada version of an English lesson cheap.
  language_code text check (language_code is null or language_code in ('en-IN', 'hi-IN', 'kn-IN')),
  scene_index smallint check (scene_index is null or scene_index between 1 and 8),
  storage_bucket text not null check (char_length(btrim(storage_bucket)) between 1 and 100),
  storage_key text not null check (char_length(btrim(storage_key)) between 1 and 400),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size > 0),
  mime_type text check (mime_type is null or char_length(btrim(mime_type)) between 3 and 150),
  -- Bumped when the same logical asset is regenerated, so an older row stays
  -- readable for audit instead of being overwritten.
  version integer not null default 1 check (version > 0),
  status public.lesson_asset_status not null default 'pending',
  -- The content-addressed key from src/lib/lesson-spec/keys.ts. Two lessons that
  -- would produce byte-identical output share it, which is what lets a narration
  -- change reuse the keyframes it did not touch.
  cache_key text check (cache_key is null or cache_key ~ '^[0-9a-f]{16,64}$'),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 400),
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  -- Validation means a checksum was computed against the stored object. A row
  -- cannot claim `ready` without one, because a URL is not evidence of bytes.
  constraint lesson_assets_ready_is_validated check (
    status <> 'ready'
    or (checksum_sha256 is not null and byte_size is not null and validated_at is not null)
  )
);

-- One live row per logical asset. Regeneration bumps `version` rather than
-- inserting a duplicate, so "which video is current" has one answer.
create unique index if not exists lesson_assets_identity_idx
  on public.lesson_assets (project_id, kind, coalesce(language_code, ''),
                           coalesce(scene_index, 0), version);
create index if not exists lesson_assets_project_idx on public.lesson_assets (project_id);
create index if not exists lesson_assets_cache_key_idx
  on public.lesson_assets (cache_key) where cache_key is not null;
create index if not exists lesson_assets_status_idx
  on public.lesson_assets (status) where status <> 'ready';

comment on table public.lesson_assets is
  'One row per stored object. Binaries live in Supabase Storage; this table '
  'holds identity, integrity and state so a lesson can be verified without '
  'downloading it.';

-- ── 3. Reuse events ─────────────────────────────────────────────────────────
-- Who asked, what they were given instead of generating, and what that avoided.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lesson_reuse_decision') then
    create type public.lesson_reuse_decision as enum
      ('full', 'partial', 'language_variant', 'miss');
  end if;
  if not exists (select 1 from pg_type where typname = 'cost_basis') then
    -- Mirrors CostBasis in src/lib/generation/cost.ts. `unknown` exists so an
    -- unpriced saving is recorded as unpriced rather than silently as zero.
    create type public.cost_basis as enum ('measured', 'estimated', 'unknown');
  end if;
end $$;

create table if not exists public.lesson_reuse_events (
  id uuid primary key default extensions.gen_random_uuid(),
  -- The teacher who made the request. Clerk subject, matching owner_id elsewhere.
  requested_by text not null check (char_length(btrim(requested_by)) between 1 and 255),
  -- Their project. The source project is referenced but never exposed to them.
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  source_project_id uuid references public.cloud_lesson_projects (id) on delete set null,
  school_id uuid references public.schools (id) on delete set null,
  decision public.lesson_reuse_decision not null,
  -- Which outputs the reuse actually satisfied, and which still had to be built.
  satisfied_outputs public.lesson_output_kind[] not null default '{}',
  generated_outputs public.lesson_output_kind[] not null default '{}',
  reused_asset_ids uuid[] not null default '{}',
  -- What was avoided, and how firmly that is known. A number without its basis
  -- is the thing this column exists to prevent.
  savings_usd numeric(12, 6) check (savings_usd is null or savings_usd >= 0),
  savings_basis public.cost_basis not null default 'unknown',
  savings_gpu_seconds numeric(12, 3) check (savings_gpu_seconds is null or savings_gpu_seconds >= 0),
  -- Why this decision, in a form a person can read during an audit.
  rationale text check (rationale is null or char_length(rationale) <= 600),
  created_at timestamptz not null default now(),
  -- An estimate must not masquerade as a measurement, and a measured saving
  -- must actually carry a figure.
  constraint lesson_reuse_events_basis_agrees check (
    (savings_basis = 'unknown' and savings_usd is null)
    or (savings_basis in ('measured', 'estimated') and savings_usd is not null)
  )
);

create index if not exists lesson_reuse_events_project_idx
  on public.lesson_reuse_events (project_id);
create index if not exists lesson_reuse_events_requested_by_idx
  on public.lesson_reuse_events (requested_by, created_at desc);
create index if not exists lesson_reuse_events_source_idx
  on public.lesson_reuse_events (source_project_id) where source_project_id is not null;

comment on table public.lesson_reuse_events is
  'Audit trail for shared reuse. source_project_id is for administrators: a '
  'teacher is never shown whose lesson they were served.';

-- ── 4. Readiness ────────────────────────────────────────────────────────────

create or replace function public.lesson_outputs_ready(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Every requested output has a validated asset. Scene-level artefacts
  -- (keyframes, clips, narration) are intermediate and deliberately not
  -- required: a lesson is ready when what the teacher asked for exists.
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

comment on function public.lesson_outputs_ready(uuid) is
  'True when every requested output has a validated asset. A lesson is not '
  'publishable for reuse before this holds.';

-- Which outputs an existing project can serve to a new request. The caller
-- supplies what it wants; the answer names only what is actually there.
create or replace function public.lesson_available_outputs(p_project_id uuid)
returns public.lesson_output_kind[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct a.kind::text::public.lesson_output_kind), '{}')
  from public.lesson_assets a
  where a.project_id = p_project_id
    and a.status = 'ready'
    and a.kind::text in ('video', 'pptx');
$$;

-- ── 5. Row level security ───────────────────────────────────────────────────
-- Same shape as the lesson tables: a teacher reads their own rows, and writes
-- arrive through the service role in the worker.

alter table public.lesson_assets enable row level security;
alter table public.lesson_reuse_events enable row level security;

drop policy if exists "lesson assets: read own" on public.lesson_assets;
create policy "lesson assets: read own"
  on public.lesson_assets for select to authenticated
  using (exists (
    select 1 from public.cloud_lesson_projects p
    where p.id = project_id and p.owner_id = (select public.clerk_user_id())
  ));

drop policy if exists "lesson reuse events: read own" on public.lesson_reuse_events;
create policy "lesson reuse events: read own"
  on public.lesson_reuse_events for select to authenticated
  -- Scoped to the requesting teacher, not the source. A teacher sees that a
  -- lesson was reused for them; they do not see whose lesson it was, and the
  -- source teacher does not see who consumed theirs.
  using (requested_by = (select public.clerk_user_id()));

revoke all on table public.lesson_assets from public, anon, authenticated;
revoke all on table public.lesson_reuse_events from public, anon, authenticated;
grant select on table public.lesson_assets to authenticated;
grant select on table public.lesson_reuse_events to authenticated;
