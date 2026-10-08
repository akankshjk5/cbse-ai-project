-- ─────────────────────────────────────────────────────────────────────────────
-- 0300 · Decks, slides, assets
--
-- The core content model. A deck owns ordered slides; slides and the deck both
-- own assets (backgrounds, hero images, uploads). Ownership is stored once, on
-- the deck; children reach it through deck_id.
--
-- owner_id is a Clerk user id (text), not a uuid — see migration 0100. RLS is a
-- real boundary again: policies compare owner_id to the `sub` claim of the
-- Clerk token that Supabase verifies. src/lib/data/decks.ts still filters by
-- owner explicitly, so a policy mistake and a code mistake must BOTH happen
-- before anything leaks.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.deck_status as enum ('draft', 'generating', 'ready', 'failed', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deck_visibility as enum ('private', 'unlisted', 'public');
exception when duplicate_object then null; end $$;

create table if not exists public.decks (
  id            uuid primary key default extensions.gen_random_uuid(),
  owner_id      text not null,
  title         text not null default 'Untitled deck',
  -- The original ask, kept verbatim. Regeneration replays from this.
  source_prompt text,
  topic         text,
  audience      text,
  tone          text,
  language      text not null default 'en',
  status        public.deck_status not null default 'draft',
  visibility    public.deck_visibility not null default 'private',
  slide_count   integer not null default 0 check (slide_count >= 0),
  -- Output of the style-extractor agent: palette, type scale, motif, imagery
  -- direction. Every downstream image prompt is conditioned on this.
  style_spec    jsonb not null default '{}'::jsonb,
  theme         jsonb not null default '{}'::jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists decks_owner_updated_idx on public.decks (owner_id, updated_at desc);
create index if not exists decks_status_idx        on public.decks (status);
create index if not exists decks_title_trgm_idx    on public.decks using gin (title extensions.gin_trgm_ops);

create trigger decks_set_updated_at
  before update on public.decks
  for each row execute function public.set_updated_at();

-- Owner check for the child tables below (slides, assets, and the pipeline
-- tables in 0400). SECURITY DEFINER so a policy can read `decks` without
-- recursing into that table's own RLS. The fixed search_path is a hard
-- requirement — never remove it.
--
-- Defined here rather than in 0100 because `language sql` bodies are parsed at
-- CREATE time: public.decks must exist first.
create or replace function public.is_deck_owner(p_deck_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.decks d
    where d.id = p_deck_id
      and d.owner_id = public.clerk_user_id()
  );
$$;

revoke all on function public.is_deck_owner(uuid) from public;
grant execute on function public.is_deck_owner(uuid) to anon, authenticated, service_role;

create table if not exists public.slides (
  id             uuid primary key default extensions.gen_random_uuid(),
  deck_id        uuid not null references public.decks (id) on delete cascade,
  -- 0-based and contiguous. Reordering must renumber inside one transaction;
  -- see the deferrable unique constraint below.
  position       integer not null check (position >= 0),
  layout         text not null default 'title-body',
  title          text,
  subtitle       text,
  -- Structured content blocks: [{ type: 'bullet' | 'quote' | 'stat', ... }].
  -- Never store rendered HTML here; the renderer owns presentation.
  blocks         jsonb not null default '[]'::jsonb,
  speaker_notes  text,
  image_prompt   text,
  background_url text,
  hero_image_url text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Deferrable so a reorder can shuffle several rows in one transaction without
-- tripping the constraint mid-statement.
create unique index if not exists slides_deck_position_key on public.slides (deck_id, position);
alter table public.slides
  drop constraint if exists slides_deck_position_unique;
alter table public.slides
  add constraint slides_deck_position_unique unique using index slides_deck_position_key
  deferrable initially immediate;

create trigger slides_set_updated_at
  before update on public.slides
  for each row execute function public.set_updated_at();

do $$ begin
  create type public.asset_kind as enum ('background', 'hero', 'icon', 'chart', 'upload', 'export');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.asset_source as enum ('generated', 'unsplash', 'upload', 'youtube', 'external');
exception when duplicate_object then null; end $$;

create table if not exists public.deck_assets (
  id             uuid primary key default extensions.gen_random_uuid(),
  deck_id        uuid not null references public.decks (id) on delete cascade,
  slide_id       uuid references public.slides (id) on delete cascade,
  kind           public.asset_kind not null,
  source         public.asset_source not null,
  -- Path inside the bucket named by `bucket`. Store the path, never a signed
  -- URL — signed URLs expire and poison any cache that holds them.
  bucket         text not null default 'deck-assets',
  storage_path   text,
  external_url   text,
  provider_model text,
  prompt         text,
  width          integer,
  height         integer,
  bytes          bigint,
  -- Attribution required by Unsplash/YouTube terms: { name, profile_url, ... }.
  credit         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint deck_assets_location_present
    check (storage_path is not null or external_url is not null)
);

create index if not exists deck_assets_deck_idx  on public.deck_assets (deck_id);
create index if not exists deck_assets_slide_idx on public.deck_assets (slide_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Owners get full access through their Clerk token; anyone may read a deck the
-- owner marked public or unlisted.
--
-- Use public.clerk_user_id(), never auth.uid() — Clerk ids are text and the
-- uuid cast inside auth.uid() does not survive them.

alter table public.decks       enable row level security;
alter table public.slides      enable row level security;
alter table public.deck_assets enable row level security;

create policy "decks: owner full access"
  on public.decks for all
  to authenticated
  using (owner_id = public.clerk_user_id())
  with check (owner_id = public.clerk_user_id());

create policy "decks: read shared"
  on public.decks for select
  to anon, authenticated
  using (visibility in ('public', 'unlisted'));

create policy "slides: owner full access"
  on public.slides for all
  to authenticated
  using (public.is_deck_owner(deck_id))
  with check (public.is_deck_owner(deck_id));

create policy "slides: read shared"
  on public.slides for select
  to anon, authenticated
  using (exists (
    select 1 from public.decks d
    where d.id = slides.deck_id and d.visibility in ('public', 'unlisted')
  ));

create policy "deck_assets: owner full access"
  on public.deck_assets for all
  to authenticated
  using (public.is_deck_owner(deck_id))
  with check (public.is_deck_owner(deck_id));

create policy "deck_assets: read shared"
  on public.deck_assets for select
  to anon, authenticated
  using (exists (
    select 1 from public.decks d
    where d.id = deck_assets.deck_id and d.visibility in ('public', 'unlisted')
  ));

-- Keep decks.slide_count honest without the app having to remember to.
create or replace function public.sync_deck_slide_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.deck_id, old.deck_id);
begin
  update public.decks d
     set slide_count = (select count(*) from public.slides s where s.deck_id = target)
   where d.id = target;
  return null;
end;
$$;

revoke all on function public.sync_deck_slide_count() from public, anon, authenticated;

create trigger slides_sync_deck_count
  after insert or delete on public.slides
  for each row execute function public.sync_deck_slide_count();
