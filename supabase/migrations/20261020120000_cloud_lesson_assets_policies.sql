-- ─────────────────────────────────────────────────────────────────────────────
-- 20261020120000 · Storage policies for cloud-lesson-assets
--
-- The bucket is declared `public = true` and has **no storage policies at all**.
-- The other two asset buckets each carry an explicit set; this one carries the
-- bucket row and nothing else.
--
-- That has two consequences:
--
--   1. Today: every object is served to anyone with the URL. The database rows
--      are protected by RLS; the bytes are not.
--   2. On a flip to private: nobody could read anything, including the teacher
--      who owns it, because there would be no policy to permit it. Flipping
--      first and adding policies afterwards would be an outage.
--
-- So the policies land first, while the bucket is still public, where they
-- change nothing: a public bucket serves reads through an endpoint that does
-- not consult RLS. They are the prerequisite for the flip, not the flip.
--
-- **This migration does not change bucket visibility.** `public` is untouched,
-- and nothing here makes an already-issued public URL private. See
-- docs/private-buckets-migration.md.
--
-- The isolation key is the first path segment. All four writers agree on
-- `<project_id>/<kind>/<file>`:
--
--   worker.ts        <project_id>/narration/<job_id>-<uuid>.wav
--   image-worker.ts  <project_id>/media/<job_id>-<uuid>.png
--   media-worker.ts  <project_id>/media/<job_id>-<label>-<uuid>.mp4
--   deck-worker.ts   <project_id>/deck/<job_id>-<uuid>.pptx
--
-- so ownership is decided by joining that segment to cloud_lesson_projects
-- rather than by trusting a claim in the path. A teacher who guesses another
-- teacher's object name still fails the join.
-- ─────────────────────────────────────────────────────────────────────────────

-- Readable by the teacher who owns the lesson the object belongs to.
--
-- `(storage.foldername(name))[1]` is the first path segment. For a name with
-- no slash it is the whole filename, NOT null -- `foldername` only strips a
-- trailing component when there is a `/` to strip. So a stray object at the
-- bucket root is denied because a project UUID never equals a filename, which
-- is the right outcome by a different route than null handling. Worth stating
-- because a later change made in the belief that nulls do the denying would
-- open the root up.
drop policy if exists "cloud-lesson-assets: owner read" on storage.objects;
create policy "cloud-lesson-assets: owner read"
  on storage.objects for select
  using (
    bucket_id = 'cloud-lesson-assets'
    and exists (
      select 1 from public.cloud_lesson_projects p
      where p.owner_id = public.clerk_user_id()
        and p.id::text = (storage.foldername(name))[1]
    )
  );

-- Writes stay with the service role, which is how every worker already does it.
-- A teacher-facing client must not be able to put an object into a lesson's
-- folder: the assets are generated artefacts, and one uploaded by hand would
-- be served as though a worker had produced and checksummed it.
drop policy if exists "cloud-lesson-assets: service role writes" on storage.objects;
create policy "cloud-lesson-assets: service role writes"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'cloud-lesson-assets');

drop policy if exists "cloud-lesson-assets: service role updates" on storage.objects;
create policy "cloud-lesson-assets: service role updates"
  on storage.objects for update
  to service_role
  using (bucket_id = 'cloud-lesson-assets')
  with check (bucket_id = 'cloud-lesson-assets');

drop policy if exists "cloud-lesson-assets: service role deletes" on storage.objects;
create policy "cloud-lesson-assets: service role deletes"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'cloud-lesson-assets');

comment on table storage.objects is
  'Lumina: cloud-lesson-assets reads are owner-scoped by joining the first path '
  'segment to cloud_lesson_projects. The bucket is still public, so these '
  'policies are the prerequisite for making it private, not the act of doing so.';
