-- ─────────────────────────────────────────────────────────────────────────────
-- 0802 · deck-exports bucket
--
-- Migration 0700 created `deck_exports` and documented its `storage_path` as
-- "Path in the `deck-exports` bucket" — but 0600 only ever created
-- `deck-assets` and `deck-uploads`. The bucket the export rows point at did
-- not exist, so the first upload from the generation pipeline would have
-- failed with "Bucket not found". This adds it.
--
-- Private, like deck-uploads: a rendered deck is the user's work, downloaded
-- through a signed URL rather than hotlinked. Same `<deck_id>/...` layout as
-- every other bucket here, because the policies authorise on that first
-- segment via public.storage_deck_id().
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('deck-exports', 'deck-exports', false, 104857600,
   array[
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/pdf',
     'application/zip'
   ])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Owner-only, every verb. Writes come from the service-role worker (which
-- bypasses this), so in practice the policy governs the owner's own reads.
drop policy if exists "deck-exports: owner all" on storage.objects;
create policy "deck-exports: owner all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'deck-exports' and public.is_deck_owner(public.storage_deck_id(name)))
  with check (bucket_id = 'deck-exports' and public.is_deck_owner(public.storage_deck_id(name)));
