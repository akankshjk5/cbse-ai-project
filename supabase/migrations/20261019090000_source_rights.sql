-- Rights that the database enforces, and a content mode that says why.
--
-- `src/lib/textbooks/ktbs.ts` declares `ReuseRights` above the comment
-- "Nothing publishes at `unresolved`." Nothing enforced it. An audit on
-- 19 October 2026 found no rights column anywhere: `reserve_cloud_lesson`
-- mentions rights, licence or permission zero times, `lesson_assets` has no
-- rights column, and `publish_cloud_lesson` checked only that files existed.
-- A lesson derived from material whose rights are genuinely unresolved could
-- be published, marked reusable and served across a school with nothing
-- objecting — into buckets that are `public = true`.
--
-- Two ideas, deliberately separate.
--
-- CONTENT MODE says where a lesson's substance came from. Most lessons during
-- this phase are `original_generated`: written from a teacher's topic and
-- objective, owing nothing to a protected source. Those carry no source rows
-- and publish under the original-content policy. Inventing a government source
-- for them would be worse than having none.
--
-- SOURCE RIGHTS apply only when a lesson genuinely depends on something
-- external. Every default here is the restrictive one, because the failure
-- mode of a permissive default is a copyright incident that nobody notices
-- until it is public.

-- ── 1. Content mode ─────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lesson_content_mode') then
    create type public.lesson_content_mode as enum
      ('original_generated', 'licensed_source', 'teacher_supplied');
  end if;
end $$;

alter table public.cloud_lesson_projects
  add column if not exists content_mode public.lesson_content_mode
    not null default 'original_generated';

comment on column public.cloud_lesson_projects.content_mode is
  'Where the lesson''s substance came from. original_generated owes nothing to '
  'a protected source and carries no source rows; the other two must.';

-- ── 2. Sources ──────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'source_rights_status') then
    -- `unresolved` is the default and means exactly that: nobody has asked.
    -- It is not a soft yes.
    create type public.source_rights_status as enum
      ('unresolved', 'approved', 'restricted', 'revoked');
  end if;
  if not exists (select 1 from pg_type where typname = 'distribution_scope') then
    -- Ordered from least to most exposure. Each is granted explicitly; none
    -- implies another.
    create type public.distribution_scope as enum
      ('internal_processing', 'private_review', 'single_school',
       'cross_school', 'public_distribution');
  end if;
end $$;

create table if not exists public.lesson_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  source_type text not null
    check (source_type in ('textbook', 'teacher_upload', 'open_licence', 'other')),
  title text not null check (char_length(btrim(title)) between 2 and 300),
  edition text check (edition is null or char_length(btrim(edition)) between 2 and 60),
  class_level smallint check (class_level is null or class_level between 1 and 12),
  subject text check (subject is null or char_length(btrim(subject)) between 2 and 100),
  chapter text check (chapter is null or char_length(btrim(chapter)) between 1 and 200),
  page_range text check (page_range is null or char_length(btrim(page_range)) between 1 and 60),

  rights_status public.source_rights_status not null default 'unresolved',
  -- Why permission is believed to exist. Free text because a licence, an
  -- email and a statute read nothing alike, and forcing them into an enum
  -- would lose what a reviewer actually relied on.
  permission_basis text check (permission_basis is null or char_length(permission_basis) <= 1000),
  -- Where the evidence lives. A status without this is an assertion.
  evidence_ref text check (evidence_ref is null or char_length(btrim(evidence_ref)) between 3 and 500),
  attribution_required text check (attribution_required is null or char_length(attribution_required) <= 500),

  -- Granted scopes. Empty by default: no evidence, no permission.
  allowed_scopes public.distribution_scope[] not null default '{}',

  reviewed_by text check (reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 255),
  reviewed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Approval is a decision somebody made, so it carries who and when and on
  -- what basis. Without those it is a guess with a confident label.
  constraint lesson_sources_approval_is_evidenced check (
    rights_status <> 'approved'
    or (evidence_ref is not null and reviewed_by is not null and reviewed_at is not null)
  ),
  -- Only an approved source may grant anything beyond processing it privately.
  constraint lesson_sources_scopes_need_approval check (
    rights_status = 'approved'
    or allowed_scopes <@ array['internal_processing', 'private_review']::public.distribution_scope[]
  ),
  constraint lesson_sources_revocation_is_recorded check (
    (rights_status = 'revoked') = (revoked_at is not null)
  )
);

create index if not exists lesson_sources_status_idx on public.lesson_sources (rights_status);
create index if not exists lesson_sources_lookup_idx
  on public.lesson_sources (source_type, class_level, subject);

comment on table public.lesson_sources is
  'External material a lesson depends on. Defaults refuse everything: a row '
  'with no evidence grants no scope, and approval requires a named reviewer.';

-- ── 3. Which lessons depend on which sources ────────────────────────────────

create table if not exists public.lesson_source_links (
  project_id uuid not null references public.cloud_lesson_projects (id) on delete cascade,
  source_id uuid not null references public.lesson_sources (id) on delete restrict,
  -- A required source gates publication. An optional one is background
  -- reading that shaped the lesson without appearing in it.
  required boolean not null default true,
  note text check (note is null or char_length(note) <= 400),
  created_at timestamptz not null default now(),
  primary key (project_id, source_id)
);

create index if not exists lesson_source_links_source_idx
  on public.lesson_source_links (source_id);

-- `on delete restrict` above is deliberate: a source still linked to a lesson
-- cannot be deleted, so the audit trail cannot be erased by tidying.

-- ── 4. The decision, as one function ────────────────────────────────────────

create or replace function public.lesson_rights_verdict(
  p_project_id uuid,
  p_scope public.distribution_scope
)
returns table (allowed boolean, reason text, blocking_source_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode public.lesson_content_mode;
  v_blocking uuid[];
  v_count int;
begin
  select p.content_mode into v_mode
  from public.cloud_lesson_projects p where p.id = p_project_id;
  if v_mode is null then
    return query select false, 'no such lesson'::text, '{}'::uuid[];
    return;
  end if;

  select array_agg(s.id) into v_blocking
  from public.lesson_source_links l
  join public.lesson_sources s on s.id = l.source_id
  where l.project_id = p_project_id
    and l.required
    and (s.rights_status <> 'approved' or not (p_scope = any (s.allowed_scopes)));

  v_blocking := coalesce(v_blocking, '{}'::uuid[]);
  select count(*) into v_count
  from public.lesson_source_links l where l.project_id = p_project_id and l.required;

  -- Original content with no required source is governed by the
  -- original-content policy, not by a source grant it does not have.
  if v_mode = 'original_generated' and v_count = 0 then
    return query select true, 'original generated content, no required source'::text, v_blocking;
    return;
  end if;

  -- A mode that claims a source must actually have one. Otherwise "licensed"
  -- is a word rather than a record.
  if v_mode <> 'original_generated' and v_count = 0 then
    return query select false,
      format('content_mode %s declares a source dependency but no required source is linked', v_mode)::text,
      v_blocking;
    return;
  end if;

  if array_length(v_blocking, 1) > 0 then
    return query select false,
      format('%s required source(s) do not permit %s', array_length(v_blocking, 1), p_scope)::text,
      v_blocking;
    return;
  end if;

  return query select true,
    format('every required source permits %s', p_scope)::text, v_blocking;
end;
$$;

comment on function public.lesson_rights_verdict is
  'Whether a lesson may be distributed at a scope. Fails closed: an unknown '
  'lesson, an unapproved source, or a mode claiming a source it does not have.';

-- ── 5. Publication, now rights-aware ────────────────────────────────────────

-- The single-argument version from 20261018140000 is replaced, not kept
-- beside this one: with a defaulted second parameter the two would be
-- ambiguous for every existing caller, and `asset-store.ts` calls it with one
-- argument. Dropping first keeps that call working, now rights-checked.
drop function if exists public.publish_cloud_lesson(uuid);

create or replace function public.publish_cloud_lesson(
  p_project_id uuid,
  p_scope public.distribution_scope default 'single_school'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ready boolean;
  v_allowed boolean;
  v_reason text;
begin
  -- The sources are locked for the rest of the transaction BEFORE they are
  -- read. A revocation committing between the check and the update would
  -- otherwise be invisible, and the lesson would publish against permission
  -- that no longer existed. FOR SHARE lets concurrent publications proceed
  -- while blocking a writer until this transaction ends.
  perform 1
  from public.lesson_sources s
  join public.lesson_source_links l on l.source_id = s.id
  where l.project_id = p_project_id and l.required
  for share of s;

  select public.lesson_outputs_ready(p_project_id) into v_ready;
  if not v_ready then
    return false;
  end if;

  select v.allowed, v.reason into v_allowed, v_reason
  from public.lesson_rights_verdict(p_project_id, p_scope) v;

  if not v_allowed then
    -- Refusing is a decision worth keeping. An operator asking why a lesson
    -- never appeared should find the answer rather than an absence.
    insert into public.lesson_reuse_events (
      requested_by, project_id, decision, satisfied_outputs, generated_outputs,
      savings_basis, rationale
    )
    select p.owner_id, p.id, 'miss', '{}', '{}', 'unknown',
           left(format('publication refused at %s: %s', p_scope, v_reason), 600)
    from public.cloud_lesson_projects p where p.id = p_project_id;
    return false;
  end if;

  update public.cloud_lesson_projects
  set status = 'succeeded', completed_at = coalesce(completed_at, now())
  where id = p_project_id and status <> 'succeeded';
  return true;
end;
$$;

comment on function public.publish_cloud_lesson(uuid, public.distribution_scope) is
  'Publishes only when every requested output is verified AND every required '
  'source permits the scope. Locks the sources first, so a concurrent '
  'revocation cannot be missed.';

-- ── 6. Reuse, bounded by the same grants ────────────────────────────────────

create or replace function public.lesson_reusable_at(
  p_project_id uuid,
  p_scope public.distribution_scope
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Reuse is distribution. A lesson cleared for one school is not thereby
  -- cleared for the next, and a cached public URL is not evidence of either.
  select coalesce((select v.allowed from public.lesson_rights_verdict(p_project_id, p_scope) v), false);
$$;

-- ── 7. Row level security ───────────────────────────────────────────────────

alter table public.lesson_sources enable row level security;
alter table public.lesson_source_links enable row level security;

drop policy if exists "lesson sources: read linked" on public.lesson_sources;
create policy "lesson sources: read linked"
  on public.lesson_sources for select to authenticated
  -- A teacher sees the rights behind their own lessons, so they can tell why
  -- one will not publish. They cannot browse the whole rights register.
  -- `lesson_sources.id` is written out in full. Unqualified `id` resolves to
  -- `cloud_lesson_projects.id` from the join below — the innermost scope wins —
  -- which makes the condition `l.source_id = p.id`, always false. The policy
  -- then hides every row including the owner's, which looks like a working
  -- restriction rather than a broken one.
  using (exists (
    select 1 from public.lesson_source_links l
    join public.cloud_lesson_projects p on p.id = l.project_id
    where l.source_id = public.lesson_sources.id
      and p.owner_id = (select public.clerk_user_id())
  ));

drop policy if exists "lesson source links: read own" on public.lesson_source_links;
create policy "lesson source links: read own"
  on public.lesson_source_links for select to authenticated
  using (exists (
    select 1 from public.cloud_lesson_projects p
    where p.id = project_id and p.owner_id = (select public.clerk_user_id())
  ));

revoke all on table public.lesson_sources from public, anon, authenticated;
revoke all on table public.lesson_source_links from public, anon, authenticated;
grant select on table public.lesson_sources to authenticated;
grant select on table public.lesson_source_links to authenticated;
