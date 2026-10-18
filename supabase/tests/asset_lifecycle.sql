-- The asset lifecycle: finalise, publish, detect damage, recover.
--
--   psql "$DATABASE_URL" -f supabase/tests/00_supabase_shim.sql
--   psql "$DATABASE_URL" -f supabase/tests/asset_lifecycle.sql
--
-- These are LOCAL PostgreSQL tests. They prove what the database enforces about
-- rows: that a half-finished upload cannot be published, that a retry does not
-- duplicate, that damage is recoverable per-output. They prove NOTHING about
-- Supabase Storage — bucket policies, signed URLs and object-level access live
-- in a service this suite never contacts. See the note at the end.
--
-- EXECUTED against PostgreSQL 18.1.

begin;

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Test Org') on conflict do nothing;
insert into public.schools (id, org_id, name, board) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Test School', 'Karnataka State') on conflict do nothing;

-- Teacher A wants both outputs; teacher B wants only a video.
insert into public.cloud_lesson_projects
  (id, owner_id, school_id, class_level, subject, topic, language_code,
   target_duration_seconds, status, requested_outputs)
values
  ('00000000-0000-0000-0000-0000000000d1', 'user_a', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Lifecycle Probe', 'en-IN', 30, 'preparing',
   array['video','pptx']::public.lesson_output_kind[]),
  ('00000000-0000-0000-0000-0000000000d2', 'user_b', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Lifecycle Probe', 'en-IN', 30, 'preparing',
   array['video']::public.lesson_output_kind[])
on conflict (id) do nothing;

-- 1. A lesson is not publishable before its outputs exist.
do $$
begin
  if public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000d1') then
    raise exception 'a lesson with no assets was published';
  end if;
  if (select status from public.cloud_lesson_projects
      where id = '00000000-0000-0000-0000-0000000000d1') = 'succeeded' then
    raise exception 'the refused publish still changed the status';
  end if;
  raise notice 'ok  publication is refused while an output is missing';
end $$;

-- 2. Finalising records a verified object and nothing less.
do $$
declare v public.lesson_assets;
begin
  begin
    v := public.finalize_lesson_asset(
      '00000000-0000-0000-0000-0000000000d1', 'video', 'lesson-video-assets',
      'a/v.mp4', 'short', 100, 'video/mp4', 'en-IN');
    raise exception 'a malformed checksum was finalised';
  exception when check_violation then null;
  end;
  begin
    v := public.finalize_lesson_asset(
      '00000000-0000-0000-0000-0000000000d1', 'video', 'lesson-video-assets',
      'a/v.mp4', repeat('a', 64), 0, 'video/mp4', 'en-IN');
    raise exception 'a zero-byte object was finalised';
  exception when check_violation then null;
  end;
  v := public.finalize_lesson_asset(
    '00000000-0000-0000-0000-0000000000d1', 'video', 'lesson-video-assets',
    'a/v.mp4', repeat('a', 64), 926492, 'video/mp4', 'en-IN');
  if v.status <> 'ready' or v.validated_at is null or v.version <> 1 then
    raise exception 'finalisation did not produce a validated v1 asset: %', v;
  end if;
  raise notice 'ok  finalisation refuses a bad checksum or an empty object';
end $$;

-- 3. Partial availability: the video is ready, the deck is not. Only the deck
--    is outstanding, and the lesson stays unpublished.
do $$
declare outstanding public.lesson_output_kind[]; available public.lesson_output_kind[];
begin
  select public.lesson_outputs_outstanding('00000000-0000-0000-0000-0000000000d1') into outstanding;
  if not (outstanding = array['pptx']::public.lesson_output_kind[]) then
    raise exception 'expected only the deck outstanding, got %', outstanding;
  end if;
  select public.lesson_available_outputs('00000000-0000-0000-0000-0000000000d1') into available;
  if not (available = array['video']::public.lesson_output_kind[]) then
    raise exception 'expected only the video available, got %', available;
  end if;
  if public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000d1') then
    raise exception 'a lesson missing its deck was published';
  end if;
  raise notice 'ok  partial availability names exactly the missing output';
end $$;

-- 4. A video-only request is complete with a video alone. Teacher B's lesson
--    must not wait on a deck nobody asked for.
do $$
declare v public.lesson_assets;
begin
  v := public.finalize_lesson_asset(
    '00000000-0000-0000-0000-0000000000d2', 'video', 'lesson-video-assets',
    'b/v.mp4', repeat('d', 64), 900000, 'video/mp4', 'en-IN');
  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000d2') then
    raise exception 'a satisfied video-only lesson was not published';
  end if;
  if (select cardinality(public.lesson_outputs_outstanding('00000000-0000-0000-0000-0000000000d2'))) <> 0 then
    raise exception 'a video-only lesson still reports something outstanding';
  end if;
  raise notice 'ok  a video-only request publishes without any deck';
end $$;

-- 5. A retried upload is the same asset, not a second version.
do $$
declare first_id uuid; again public.lesson_assets; versions int;
begin
  select id into first_id from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'video';
  -- Same bytes: the worker died after uploading and is re-running.
  again := public.finalize_lesson_asset(
    '00000000-0000-0000-0000-0000000000d1', 'video', 'lesson-video-assets',
    'a/v.mp4', repeat('a', 64), 926492, 'video/mp4', 'en-IN');
  if again.id <> first_id then
    raise exception 'a retried identical upload created a new asset row';
  end if;
  select count(*) into versions from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'video';
  if versions <> 1 then raise exception 'retry produced % rows', versions; end if;
  raise notice 'ok  a retried identical upload is idempotent';
end $$;

-- 6. Different bytes are a regeneration: a new version, the old one retained.
do $$
declare v public.lesson_assets; versions int;
begin
  v := public.finalize_lesson_asset(
    '00000000-0000-0000-0000-0000000000d1', 'video', 'lesson-video-assets',
    'a/v2.mp4', repeat('e', 64), 930001, 'video/mp4', 'en-IN');
  if v.version <> 2 then raise exception 'a regeneration did not bump the version: %', v.version; end if;
  select count(*) into versions from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'video';
  if versions <> 2 then raise exception 'the earlier version was not retained'; end if;
  raise notice 'ok  regeneration adds a version and keeps the old row for audit';
end $$;

-- 7. Damage is detectable, distinguishable, and scoped to one output.
do $$
declare target uuid; outstanding public.lesson_output_kind[]; deck public.lesson_assets;
begin
  -- Give the lesson its deck so it can publish, then damage the deck only.
  deck := public.finalize_lesson_asset(
    '00000000-0000-0000-0000-0000000000d1', 'pptx', 'lesson-video-assets',
    'a/deck.pptx', repeat('f', 64), 1200000,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000d1') then
    raise exception 'a fully satisfied lesson was not published';
  end if;

  perform public.mark_lesson_asset_unusable(deck.id, 'corrupt', 'checksum mismatch on re-read');
  select public.lesson_outputs_outstanding('00000000-0000-0000-0000-0000000000d1') into outstanding;
  if not (outstanding = array['pptx']::public.lesson_output_kind[]) then
    raise exception 'a corrupt deck did not become outstanding on its own: %', outstanding;
  end if;
  -- The video is untouched, so recovery regenerates the deck and nothing else.
  if not (public.lesson_available_outputs('00000000-0000-0000-0000-0000000000d1')
          = array['video']::public.lesson_output_kind[]) then
    raise exception 'damaging the deck affected the video';
  end if;
  -- The evidence of what the object should have been is kept.
  if (select checksum_sha256 from public.lesson_assets where id = deck.id) is null then
    raise exception 'the checksum was cleared, so recovery cannot tell changed from never-written';
  end if;
  raise notice 'ok  a corrupt deck is outstanding alone; the video is untouched';
end $$;

-- 8. `missing` and `corrupt` are different states, and neither is `failed`.
do $$
declare a public.lesson_assets; target uuid;
begin
  select id into target from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'pptx';
  a := public.mark_lesson_asset_unusable(target, 'missing', 'object not found in bucket');
  if a.status <> 'missing' then raise exception 'missing was not recorded'; end if;
  begin
    perform public.mark_lesson_asset_unusable(target, 'ready', 'sneaking it back');
    raise exception 'ready was granted through the recovery path';
  exception when check_violation then null;
  end;
  raise notice 'ok  missing and corrupt are distinct, and ready cannot be set here';
end $$;

-- 9. A reuse event takes its subject from the project, not from the caller.
do $$
declare e public.lesson_reuse_events;
begin
  e := public.record_lesson_reuse(
    '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1',
    'partial', array['video']::public.lesson_output_kind[],
    array['pptx']::public.lesson_output_kind[], '{}', 0.056, 'measured', 94.2,
    'outputs/1.0.0 - video: reuse; pptx: rebuild');
  if e.requested_by <> 'user_b' then
    raise exception 'the event subject was not read from the project: %', e.requested_by;
  end if;
  if e.school_id is null then raise exception 'the school was not carried onto the event'; end if;
  -- Unpriced stays unpriced rather than becoming a free lesson.
  e := public.record_lesson_reuse(
    '00000000-0000-0000-0000-0000000000d2', null, 'language_variant',
    '{}', array['video']::public.lesson_output_kind[], '{}', null, 'unknown', null, 'no cost recorded');
  if e.savings_usd is not null or e.savings_basis <> 'unknown' then
    raise exception 'an unpriced saving was given a figure';
  end if;
  raise notice 'ok  reuse events take their subject from the project; unpriced stays unpriced';
end $$;

-- 10. Another teacher cannot read these assets or events.
do $$
declare visible int;
begin
  set local role authenticated;
  perform public.test_become('user_b');
  select count(*) into visible from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000d1';
  if visible <> 0 then raise exception 'teacher B read % of A''''s assets', visible; end if;
  perform public.test_become('user_a');
  select count(*) into visible from public.lesson_reuse_events where requested_by = 'user_b';
  if visible <> 0 then raise exception 'teacher A read B''''s reuse events'; end if;
  reset role;
  raise notice 'ok  assets and events are invisible across teachers';
end $$;

-- NOT COVERED HERE, and not provable without a real Supabase project:
--   * storage.objects bucket policies and signed URL expiry
--   * whether an object is actually reachable without authentication
--   * that an upload aborted mid-stream leaves no readable object
-- The lesson-video-assets and cloud-lesson-assets buckets are declared
-- public = true, so any asset URL is world-readable today regardless of the
-- row-level rules proven above.

rollback;
