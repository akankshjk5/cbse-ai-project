-- ─────────────────────────────────────────────────────────────────────────────
-- 0500 · RAG corpus (pgvector)
--
-- Source material a user attaches to a deck — URLs, PDFs, pasted text, YouTube
-- transcripts — chunked and embedded so the research agents can ground on it.
--
-- DIMENSION LOCK: embedding is vector(1536), matching GENAI_EMBED_MODEL
-- (gemini-embedding-001) requested with output_dimensionality=1536. 1536 is not
-- arbitrary: pgvector's HNSW index refuses anything over 2000 dims, so the
-- model's native 3072 cannot be indexed. If you ever change the embedding model
-- or its dimensionality you MUST write a new migration that re-types this
-- column and re-embed the whole corpus — mixing vectors from two models returns
-- plausible-looking nonsense with no error.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.document_source as enum ('url', 'pdf', 'text', 'youtube', 'upload');
exception when duplicate_object then null; end $$;

create table if not exists public.documents (
  id            uuid primary key default extensions.gen_random_uuid(),
  owner_id      text not null,
  -- Null = part of the user's personal library, reusable across decks.
  deck_id       uuid references public.decks (id) on delete cascade,
  title         text,
  source_type   public.document_source not null,
  source_url    text,
  storage_path  text,
  -- Extracted plain text. Kept alongside the chunks so re-chunking never needs
  -- to re-fetch the source.
  content       text,
  token_count   integer,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists documents_owner_idx on public.documents (owner_id, created_at desc);
create index if not exists documents_deck_idx  on public.documents (deck_id);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

create table if not exists public.document_chunks (
  id           uuid primary key default extensions.gen_random_uuid(),
  document_id  uuid not null references public.documents (id) on delete cascade,
  -- Denormalised from documents so the RLS check and the ANN filter stay on one
  -- table; a join here would defeat the vector index.
  owner_id     text not null,
  deck_id      uuid references public.decks (id) on delete cascade,
  chunk_index  integer not null check (chunk_index >= 0),
  content      text not null,
  token_count  integer,
  embedding    extensions.vector(1536),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists document_chunks_owner_idx on public.document_chunks (owner_id);
create index if not exists document_chunks_deck_idx  on public.document_chunks (deck_id);

-- HNSW + cosine. Build this AFTER bulk ingest on a large corpus if you ever
-- backfill; building on an empty table (here) is free.
create index if not exists document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── Retrieval ────────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER: the caller's RLS applies, so a user can only ever match
-- their own chunks and the scoping needs no argument of its own. Do not switch
-- this to DEFINER — that would silently turn it into a cross-tenant read.

create or replace function public.match_document_chunks(
  query_embedding      extensions.vector(1536),
  match_count          integer default 8,
  similarity_threshold double precision default 0.5,
  filter_deck_id       uuid default null,
  filter_document_ids  uuid[] default null
)
returns table (
  id          uuid,
  document_id uuid,
  content     text,
  similarity  double precision,
  metadata    jsonb
)
language sql
security invoker
stable
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.metadata
  from public.document_chunks c
  where c.embedding is not null
    and (filter_deck_id is null or c.deck_id = filter_deck_id)
    and (filter_document_ids is null or c.document_id = any (filter_document_ids))
    and 1 - (c.embedding <=> query_embedding) >= similarity_threshold
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1)
$$;

grant execute on function public.match_document_chunks(
  extensions.vector, integer, double precision, uuid, uuid[]
) to authenticated, service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Source material is private to its owner. No public read path.

alter table public.documents       enable row level security;
alter table public.document_chunks enable row level security;

create policy "documents: owner full access"
  on public.documents for all
  to authenticated
  using (owner_id = public.clerk_user_id())
  with check (owner_id = public.clerk_user_id());

create policy "document_chunks: owner read"
  on public.document_chunks for select
  to authenticated
  using (owner_id = public.clerk_user_id());

-- Chunks are written by the ingest worker (service role), never by the browser.
