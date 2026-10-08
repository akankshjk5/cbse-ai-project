-- ─────────────────────────────────────────────────────────────────────────────
-- 0100 · Extensions and shared helpers
--
-- Everything later in this folder assumes these exist. Extensions live in the
-- `extensions` schema (Supabase convention) so `public` stays ours.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto" with schema extensions;   -- gen_random_uuid()
create extension if not exists "vector"   with schema extensions;   -- pgvector, for RAG
create extension if not exists "pg_trgm"  with schema extensions;   -- fuzzy title search

-- Touch `updated_at` on every UPDATE. Attached by trigger on each mutable table.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity
--
-- Clerk is the identity provider, registered with Supabase as a third-party
-- auth provider. A signed-in request carries a Clerk session token, and its
-- `sub` claim is the Clerk user id — a TEXT value like `user_2abc...`, never a
-- uuid. That is what every owner_id column in this schema stores.
--
-- auth.uid() is useless here (it casts sub to uuid and errors/nulls on Clerk
-- ids). Always go through public.clerk_user_id() instead.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.clerk_user_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

-- NOTE: public.is_deck_owner() lives in migration 0300, not here. It is
-- `language sql`, so Postgres parses its body at CREATE time and the `decks`
-- table it reads must already exist. Defining it here fails with 42P01.
