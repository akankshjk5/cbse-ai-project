-- Supabase shim for a disposable local Postgres.
-- Provides only what the migrations reference: roles, the extensions schema,
-- auth.jwt()/uid() backed by a session GUC, storage tables, and the realtime
-- publication. Nothing here is part of the application.

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists private;

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "pg_trgm"  with schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

-- PostgREST sets request.jwt.claims per request; tests set it with set_config.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text,
  owner text, owner_id text, metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Test helper: act as a given Clerk user id.
create or replace function public.test_become(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false)
$$;

-- auth.users: referenced by the media tables. Supabase provides it; the shim
-- needs only the id column those foreign keys point at.
create table if not exists auth.users (
  id uuid primary key default extensions.gen_random_uuid(),
  email text, created_at timestamptz default now()
);

-- document_source normally arrives with the RAG migration, which is skipped
-- here because pgvector is unavailable. ppt_import_export references the enum
-- but not the vector column, so declaring it keeps that migration testable.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'document_source') then
    create type public.document_source as enum ('url', 'pdf', 'text', 'youtube', 'upload');
  end if;
end $$;

-- storage.foldername: Supabase's helper that splits an object name into path
-- segments, used by the bucket policies.
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select string_to_array(regexp_replace(coalesce(name, ''), '/[^/]*$', ''), '/')
$$;
