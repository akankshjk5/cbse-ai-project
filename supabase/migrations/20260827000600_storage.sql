-- ─────────────────────────────────────────────────────────────────────────────
-- 0600 · Storage buckets
--
-- Two buckets, both keyed by `<deck_id>/...` as the first path segment. Every
-- policy below authorises on that segment via public.is_deck_owner(), so ANY
-- code that uploads must use that layout or the write is rejected.
--
--   deck-assets  public  — generated backgrounds/heroes, served from the CDN
--                          and safe to hotlink from an exported deck.
--   deck-uploads private — whatever the user hands us (logos, PDFs, brand
--                          refs). Read through signed URLs only.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('deck-assets', 'deck-assets', true, 26214400,
   array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  ('deck-uploads', 'deck-uploads', false, 52428800,
   array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
         'application/pdf', 'text/plain', 'text/markdown'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Helper: first path segment as uuid, or null when it is not one.
create or replace function public.storage_deck_id(p_name text)
returns uuid
language plpgsql
immutable
as $$
begin
  return (string_to_array(p_name, '/'))[1]::uuid;
exception when others then
  return null;
end;
$$;

-- deck-assets: world-readable, owner-writable.

drop policy if exists "deck-assets: public read" on storage.objects;
create policy "deck-assets: public read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'deck-assets');

drop policy if exists "deck-assets: owner write" on storage.objects;
create policy "deck-assets: owner write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'deck-assets'
    and public.is_deck_owner(public.storage_deck_id(name))
  );

drop policy if exists "deck-assets: owner update" on storage.objects;
create policy "deck-assets: owner update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'deck-assets' and public.is_deck_owner(public.storage_deck_id(name)))
  with check (bucket_id = 'deck-assets' and public.is_deck_owner(public.storage_deck_id(name)));

drop policy if exists "deck-assets: owner delete" on storage.objects;
create policy "deck-assets: owner delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'deck-assets' and public.is_deck_owner(public.storage_deck_id(name)));

-- deck-uploads: owner-only, every verb.

drop policy if exists "deck-uploads: owner all" on storage.objects;
create policy "deck-uploads: owner all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'deck-uploads' and public.is_deck_owner(public.storage_deck_id(name)))
  with check (bucket_id = 'deck-uploads' and public.is_deck_owner(public.storage_deck_id(name)));
