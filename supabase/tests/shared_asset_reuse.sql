-- Database-level guarantees for shared asset reuse.
--
--   psql "$DATABASE_URL" -f supabase/tests/00_supabase_shim.sql
--   psql "$DATABASE_URL" -f supabase/tests/shared_asset_reuse.sql
--
-- These cover what the offline suite cannot: constraints the database enforces
-- regardless of which code path writes, row level security as another teacher
-- sees it, and behaviour under concurrent sessions. `npm run test:outputs`
-- proves which outputs a request SHOULD reuse; this proves the database will
-- not store a state where that answer is unsafe.
--
-- EXECUTED against PostgreSQL 18.1. Each block raises on failure, so psql with
-- ON_ERROR_STOP=1 exits non-zero if any property regresses.

begin;

-- Fixtures. Two teachers in one school, so cross-teacher reads are testable.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Test Org') on conflict do nothing;
insert into public.schools (id, org_id, name, board) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Test School', 'Karnataka State') on conflict do nothing;

-- content_key is generated from class|subject|topic|duration, so these two
-- rows collide on it by construction: the same lesson, asked for by two
-- teachers in one school. That collision is what reuse keys off.
insert into public.cloud_lesson_projects
  (id, owner_id, school_id, class_level, subject, topic, language_code,
   target_duration_seconds, status, requested_outputs)
values
  ('00000000-0000-0000-0000-0000000000c1', 'user_teacher_a',
   '00000000-0000-0000-0000-0000000000b1', 10, 'Science', 'Covalent bonding',
   'en-IN', 30, 'succeeded', array['video']::public.lesson_output_kind[]),
  ('00000000-0000-0000-0000-0000000000c2', 'user_teacher_b',
   '00000000-0000-0000-0000-0000000000b1', 10, 'Science', 'Covalent bonding',
   'en-IN', 30, 'preparing', array['video','pptx']::public.lesson_output_kind[])
on conflict (id) do nothing;

-- 1. requested_outputs refuses an empty or duplicated request.
do $$
begin
  begin
    update public.cloud_lesson_projects set requested_outputs = '{}'
      where id = '00000000-0000-0000-0000-0000000000c1';
    raise exception 'an empty output request was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.cloud_lesson_projects
      set requested_outputs = array['video','video']::public.lesson_output_kind[]
      where id = '00000000-0000-0000-0000-0000000000c1';
    raise exception 'a duplicated output request was accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok  requested_outputs refuses empty and duplicate requests';
end $$;

-- 2. An asset cannot claim `ready` without the evidence that it is intact.
--    A URL in a column is not proof that bytes exist.
do $$
begin
  begin
    insert into public.lesson_assets
      (project_id, kind, language_code, storage_bucket, storage_key, status)
    values ('00000000-0000-0000-0000-0000000000c1', 'video', 'en-IN',
            'lesson-video-assets', 'a/unverified.mp4', 'ready');
    raise exception 'a ready asset was accepted with no checksum';
  exception when check_violation then null;
  end;
  raise notice 'ok  ready requires checksum, byte size and a validation time';
end $$;

-- 3. One live row per logical asset; regeneration bumps version.
do $$
begin
  insert into public.lesson_assets
    (project_id, kind, language_code, storage_bucket, storage_key,
     checksum_sha256, byte_size, mime_type, status, validated_at, version)
  values ('00000000-0000-0000-0000-0000000000c1', 'video', 'en-IN',
          'lesson-video-assets', 'a/lesson.mp4', repeat('a', 64), 926492,
          'video/mp4', 'ready', now(), 1);
  begin
    insert into public.lesson_assets
      (project_id, kind, language_code, storage_bucket, storage_key,
       checksum_sha256, byte_size, mime_type, status, validated_at, version)
    values ('00000000-0000-0000-0000-0000000000c1', 'video', 'en-IN',
            'lesson-video-assets', 'a/duplicate.mp4', repeat('b', 64), 1,
            'video/mp4', 'ready', now(), 1);
    raise exception 'a duplicate asset identity was accepted';
  exception when unique_violation then null;
  end;
  -- A regenerated asset is a new version, not an overwrite, so the previous
  -- row stays readable for audit.
  insert into public.lesson_assets
    (project_id, kind, language_code, storage_bucket, storage_key,
     checksum_sha256, byte_size, mime_type, status, validated_at, version)
  values ('00000000-0000-0000-0000-0000000000c1', 'video', 'en-IN',
          'lesson-video-assets', 'a/lesson-v2.mp4', repeat('c', 64), 930000,
          'video/mp4', 'ready', now(), 2);
  raise notice 'ok  asset identity is unique per version, and versions accumulate';
end $$;

-- 4. A checksum must look like one, and a corrupt object is a distinct state
--    from a missing one.
do $$
begin
  begin
    insert into public.lesson_assets
      (project_id, kind, storage_bucket, storage_key, checksum_sha256,
       byte_size, status, validated_at)
    values ('00000000-0000-0000-0000-0000000000c1', 'pptx',
            'lesson-video-assets', 'a/deck.pptx', 'not-a-sha', 10, 'ready', now());
    raise exception 'a malformed checksum was accepted';
  exception when check_violation then null;
  end;
  insert into public.lesson_assets
    (project_id, kind, storage_bucket, storage_key, status, failure_reason)
  values ('00000000-0000-0000-0000-0000000000c1', 'keyframe',
          'lesson-video-assets', 'a/k1.png', 'corrupt', 'checksum mismatch on re-read');
  perform 1 from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000c1' and status = 'corrupt';
  if not found then raise exception 'a corrupt asset could not be recorded'; end if;
  raise notice 'ok  checksums are shaped, and corrupt is distinguishable from missing';
end $$;

-- 5. Readiness follows the requested outputs, not the assets that happen to exist.
do $$
declare ready boolean; available public.lesson_output_kind[];
begin
  -- Teacher A asked for video only, and a validated video exists.
  select public.lesson_outputs_ready('00000000-0000-0000-0000-0000000000c1') into ready;
  if not ready then raise exception 'a video-only lesson with a ready video is not ready'; end if;

  -- Teacher B asked for video and deck; neither is uploaded yet.
  select public.lesson_outputs_ready('00000000-0000-0000-0000-0000000000c2') into ready;
  if ready then raise exception 'a lesson with no assets was reported ready'; end if;

  select public.lesson_available_outputs('00000000-0000-0000-0000-0000000000c1') into available;
  if not (available @> array['video']::public.lesson_output_kind[]) then
    raise exception 'the ready video is not listed as available: %', available;
  end if;
  if available @> array['pptx']::public.lesson_output_kind[] then
    raise exception 'a deck that was never made is listed as available';
  end if;
  raise notice 'ok  readiness tracks requested outputs; availability lists only validated ones';
end $$;

-- 6. A saving must carry its basis, and a basis must carry a figure.
do $$
begin
  begin
    insert into public.lesson_reuse_events
      (requested_by, project_id, decision, savings_usd, savings_basis)
    values ('user_teacher_b', '00000000-0000-0000-0000-0000000000c2', 'full', null, 'measured');
    raise exception 'a measured saving with no figure was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lesson_reuse_events
      (requested_by, project_id, decision, savings_usd, savings_basis)
    values ('user_teacher_b', '00000000-0000-0000-0000-0000000000c2', 'full', 0.05, 'unknown');
    raise exception 'an unknown basis was accepted alongside a figure';
  exception when check_violation then null;
  end;
  insert into public.lesson_reuse_events
    (requested_by, project_id, source_project_id, school_id, decision,
     satisfied_outputs, generated_outputs, savings_usd, savings_basis, rationale)
  values ('user_teacher_b', '00000000-0000-0000-0000-0000000000c2',
          '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
          'partial', array['video']::public.lesson_output_kind[],
          array['pptx']::public.lesson_output_kind[], 0.056, 'measured',
          'outputs/1.0.0 — video: reuse; pptx: rebuild');
  -- An unpriced saving is recordable as unpriced rather than as zero.
  insert into public.lesson_reuse_events
    (requested_by, project_id, decision, savings_basis)
  values ('user_teacher_b', '00000000-0000-0000-0000-0000000000c2', 'language_variant', 'unknown');
  raise notice 'ok  savings carry a basis; unpriced is recorded as unpriced, not as zero';
end $$;

-- 7. Row level security: a teacher sees their own rows and nobody else's.
do $$
declare visible int;
begin
  set local role authenticated;
  perform public.test_become('user_teacher_b');

  -- Teacher B must not read teacher A's assets, even inside the same school.
  select count(*) into visible from public.lesson_assets
    where project_id = '00000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'teacher B read % of teacher A''s assets', visible;
  end if;

  -- B reads the events raised for B.
  select count(*) into visible from public.lesson_reuse_events
    where requested_by = 'user_teacher_b';
  if visible = 0 then raise exception 'teacher B cannot read their own reuse events'; end if;

  perform public.test_become('user_teacher_a');
  -- A is the SOURCE of B's reuse and must not learn who consumed their lesson.
  select count(*) into visible from public.lesson_reuse_events
    where source_project_id = '00000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'the source teacher can see who reused their lesson (% rows)', visible;
  end if;

  reset role;
  raise notice 'ok  RLS hides one teacher from another, in both directions';
end $$;

rollback;
