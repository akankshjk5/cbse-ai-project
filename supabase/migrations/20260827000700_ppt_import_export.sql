-- ─────────────────────────────────────────────────────────────────────────────
-- 0700 · PowerPoint (and friends) import + export
--
-- Two directions, deliberately separate tables rather than one "jobs" table:
--
--   deck_imports  a file the user hands us (.pptx, .pdf, .docx...) which gets
--                 parsed into a deck. Lives even if parsing fails, so the user
--                 can see why.
--   deck_exports  a rendered artefact produced FROM a deck (.pptx, .pdf, a zip
--                 of slide images). Regenerated on demand; safe to delete.
--
-- Both carry a status because the work is asynchronous — a 40MB deck does not
-- convert inside a request. Both reuse public.run_status from migration 0400.
--
-- Files live in storage, never in Postgres: these rows hold a bucket path.
-- ─────────────────────────────────────────────────────────────────────────────

-- PPTX/DOCX as RAG source material too — a user may attach a deck as reference
-- without importing it. ADD VALUE is safe in a transaction on PG12+ as long as
-- the new value is not used in that same transaction; nothing below uses them.
alter type public.document_source add value if not exists 'pptx';
alter type public.document_source add value if not exists 'docx';

do $$ begin
  create type public.import_format as enum ('pptx', 'ppt', 'pdf', 'docx', 'markdown', 'text');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.export_format as enum ('pptx', 'pdf', 'png_zip');
exception when duplicate_object then null; end $$;

-- ── Imports ──────────────────────────────────────────────────────────────────

create table if not exists public.deck_imports (
  id                uuid primary key default extensions.gen_random_uuid(),
  -- Clerk user id (text) — see migration 0100.
  owner_id          text not null,
  -- Null until parsing succeeds and produces a deck. Kept null on failure so a
  -- failed import never leaves a half-built deck lying around.
  deck_id           uuid references public.decks (id) on delete set null,
  source_format     public.import_format not null,
  original_filename text not null,
  -- Path in the `deck-uploads` bucket. Uploads are keyed by deck id elsewhere;
  -- an import has no deck yet, so these are keyed `imports/<owner>/<uuid>`.
  storage_path      text not null,
  bytes             bigint,
  status            public.run_status not null default 'queued',
  -- What the parser found, before any AI touches it: slide count, detected
  -- theme, speaker notes present, etc.
  detected          jsonb not null default '{}'::jsonb,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists deck_imports_owner_idx on public.deck_imports (owner_id, created_at desc);
create index if not exists deck_imports_deck_idx  on public.deck_imports (deck_id);
-- The worker polls only for live imports.
create index if not exists deck_imports_active_idx
  on public.deck_imports (created_at)
  where status in ('queued', 'running');

create trigger deck_imports_set_updated_at
  before update on public.deck_imports
  for each row execute function public.set_updated_at();

-- ── Exports ──────────────────────────────────────────────────────────────────

create table if not exists public.deck_exports (
  id           uuid primary key default extensions.gen_random_uuid(),
  deck_id      uuid not null references public.decks (id) on delete cascade,
  owner_id     text not null,
  format       public.export_format not null,
  status       public.run_status not null default 'queued',
  -- Path in the `deck-exports` bucket, `<deck_id>/<export_id>.<ext>`.
  storage_path text,
  bytes        bigint,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists deck_exports_deck_idx  on public.deck_exports (deck_id, created_at desc);
create index if not exists deck_exports_owner_idx on public.deck_exports (owner_id, created_at desc);

create trigger deck_exports_set_updated_at
  before update on public.deck_exports
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Owners read their own rows. Writes come from the server: a user creates an
-- import/export request through a Server Action, and the worker updates status
-- with the service-role client.

alter table public.deck_imports enable row level security;
alter table public.deck_exports enable row level security;

create policy "deck_imports: owner read"
  on public.deck_imports for select
  to authenticated
  using (owner_id = public.clerk_user_id());

create policy "deck_imports: owner insert"
  on public.deck_imports for insert
  to authenticated
  with check (owner_id = public.clerk_user_id());

create policy "deck_imports: owner delete"
  on public.deck_imports for delete
  to authenticated
  using (owner_id = public.clerk_user_id());

create policy "deck_exports: owner read"
  on public.deck_exports for select
  to authenticated
  using (owner_id = public.clerk_user_id() and public.is_deck_owner(deck_id));

create policy "deck_exports: owner insert"
  on public.deck_exports for insert
  to authenticated
  with check (owner_id = public.clerk_user_id() and public.is_deck_owner(deck_id));

create policy "deck_exports: owner delete"
  on public.deck_exports for delete
  to authenticated
  using (owner_id = public.clerk_user_id() and public.is_deck_owner(deck_id));

-- ── Storage ──────────────────────────────────────────────────────────────────
--
-- deck-uploads gains the Office formats and a bigger ceiling: a slide deck with
-- embedded video clears 50MB easily. Vercel Functions accept 100MB bodies, so
-- that is the practical cap.

update storage.buckets
   set file_size_limit = 104857600,
       allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
         'application/pdf', 'text/plain', 'text/markdown',
         -- .pptx / .ppt
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/vnd.ms-powerpoint',
         -- .docx / .doc
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/msword'
       ]
 where id = 'deck-uploads';

-- Exports are private: a generated .pptx of a private deck must not be world
-- readable just because it lives in storage. Served via short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'deck-exports', 'deck-exports', false, 104857600,
  array[
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/pdf',
    'application/zip'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "deck-exports: owner all" on storage.objects;
create policy "deck-exports: owner all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'deck-exports' and public.is_deck_owner(public.storage_deck_id(name)))
  with check (bucket_id = 'deck-exports' and public.is_deck_owner(public.storage_deck_id(name)));
