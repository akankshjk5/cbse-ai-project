-- Rights enforcement, as the database applies it.
--
--   psql "$DATABASE_URL" -f supabase/tests/00_supabase_shim.sql
--   psql "$DATABASE_URL" -f supabase/tests/source_rights.sql
--
-- LOCAL PostgreSQL. These prove what the database refuses, which is the only
-- place the rule can be relied on — a TypeScript check is advice, and the UI
-- is a suggestion. They prove nothing about Supabase Storage: the buckets are
-- public, so an asset URL already handed out stays readable whatever these
-- rows say.
--
-- EXECUTED against PostgreSQL 18.1.

begin;

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Test Org') on conflict do nothing;
insert into public.schools (id, org_id, name, board) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Test School', 'Karnataka State') on conflict do nothing;

-- Four lessons, one per case. Assets are finalised so readiness never masks a
-- rights refusal: every failure below is about permission, not missing files.
insert into public.cloud_lesson_projects
  (id, owner_id, school_id, class_level, subject, topic, language_code,
   target_duration_seconds, status, requested_outputs, content_mode)
values
  ('00000000-0000-0000-0000-0000000000e1', 'user_a', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Original Carbon', 'en-IN', 30, 'preparing',
   array['video']::public.lesson_output_kind[], 'original_generated'),
  ('00000000-0000-0000-0000-0000000000e2', 'user_a', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Unresolved Source', 'en-IN', 30, 'preparing',
   array['video']::public.lesson_output_kind[], 'licensed_source'),
  ('00000000-0000-0000-0000-0000000000e3', 'user_a', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Single School Only', 'en-IN', 30, 'preparing',
   array['video']::public.lesson_output_kind[], 'licensed_source'),
  ('00000000-0000-0000-0000-0000000000e4', 'user_a', '00000000-0000-0000-0000-0000000000b1',
   10, 'Science', 'Two Sources', 'en-IN', 30, 'preparing',
   array['video']::public.lesson_output_kind[], 'licensed_source')
on conflict (id) do nothing;

do $$
declare p uuid;
begin
  foreach p in array array[
    '00000000-0000-0000-0000-0000000000e1'::uuid, '00000000-0000-0000-0000-0000000000e2'::uuid,
    '00000000-0000-0000-0000-0000000000e3'::uuid, '00000000-0000-0000-0000-0000000000e4'::uuid]
  loop
    perform public.finalize_lesson_asset(
      p, 'video', 'lesson-video-assets', 'r/' || p::text || '.mp4',
      repeat('a', 64), 900000, 'video/mp4', 'en-IN');
  end loop;
end $$;

-- 1. Original content with no source publishes. It owes nothing to anyone.
do $$
begin
  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e1', 'single_school') then
    raise exception 'original generated content was refused publication';
  end if;
  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e1', 'public_distribution') then
    raise exception 'original content was refused public distribution';
  end if;
  raise notice 'ok  original generated content publishes without a source grant';
end $$;

-- 2. A mode claiming a source must actually have one.
do $$
declare allowed boolean; reason text;
begin
  select v.allowed, v.reason into allowed, reason
  from public.lesson_rights_verdict('00000000-0000-0000-0000-0000000000e2', 'single_school') v;
  if allowed then raise exception 'licensed_source with no linked source was allowed'; end if;
  if reason not like '%no required source%' then
    raise exception 'unhelpful reason: %', reason;
  end if;
  raise notice 'ok  a lesson claiming a licensed source must link one';
end $$;

-- 3. Approval needs evidence and a named reviewer, not just a status.
do $$
begin
  begin
    insert into public.lesson_sources (source_type, title, rights_status)
    values ('textbook', 'A Textbook', 'approved');
    raise exception 'approval was accepted with no evidence or reviewer';
  exception when check_violation then null;
  end;
  -- And an unapproved source cannot be granted distribution scopes.
  begin
    insert into public.lesson_sources (source_type, title, rights_status, allowed_scopes)
    values ('textbook', 'A Textbook', 'unresolved',
            array['public_distribution']::public.distribution_scope[]);
    raise exception 'an unresolved source was granted public distribution';
  exception when check_violation then null;
  end;
  raise notice 'ok  approval requires evidence; unresolved sources grant nothing';
end $$;

-- 4. Unresolved rights block publication, at every scope.
do $$
declare src uuid; scope public.distribution_scope;
begin
  insert into public.lesson_sources (source_type, title, edition, rights_status)
  values ('textbook', 'Unresolved Science Reader', '2026-27', 'unresolved')
  returning id into src;
  insert into public.lesson_source_links (project_id, source_id)
  values ('00000000-0000-0000-0000-0000000000e2', src);

  foreach scope in array enum_range(null::public.distribution_scope) loop
    if public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e2', scope) then
      raise exception 'unresolved rights published at %', scope;
    end if;
  end loop;
  if (select status from public.cloud_lesson_projects
      where id = '00000000-0000-0000-0000-0000000000e2') = 'succeeded' then
    raise exception 'the refused lesson was marked succeeded anyway';
  end if;
  raise notice 'ok  unresolved rights block publication at every scope';
end $$;

-- 5. A refusal is recorded, so "why did this never appear" has an answer.
do $$
declare events int;
begin
  select count(*) into events from public.lesson_reuse_events
  where project_id = '00000000-0000-0000-0000-0000000000e2'
    and rationale like 'publication refused%';
  if events = 0 then raise exception 'no refusal was recorded'; end if;
  raise notice 'ok  refusals are written to the audit trail (% events)', events;
end $$;

-- 6. Single-school permission does not authorise cross-school or public.
do $$
declare src uuid;
begin
  insert into public.lesson_sources (
    source_type, title, rights_status, allowed_scopes,
    evidence_ref, reviewed_by, reviewed_at, permission_basis)
  values ('textbook', 'Licensed For One School', 'approved',
          array['internal_processing','private_review','single_school']::public.distribution_scope[],
          'permissions/2026-10-19-letter.pdf', 'rights@example.org', now(),
          'written permission limited to the requesting school')
  returning id into src;
  insert into public.lesson_source_links (project_id, source_id)
  values ('00000000-0000-0000-0000-0000000000e3', src);

  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e3', 'single_school') then
    raise exception 'an explicitly granted single-school publication was refused';
  end if;
  if public.lesson_reusable_at('00000000-0000-0000-0000-0000000000e3', 'cross_school') then
    raise exception 'single-school permission authorised cross-school reuse';
  end if;
  if public.lesson_reusable_at('00000000-0000-0000-0000-0000000000e3', 'public_distribution') then
    raise exception 'single-school permission authorised public distribution';
  end if;
  raise notice 'ok  a single-school grant covers one school and nothing wider';
end $$;

-- 7. Every required source must permit the scope, not merely one of them.
do $$
declare ok_src uuid; bad_src uuid;
begin
  insert into public.lesson_sources (
    source_type, title, rights_status, allowed_scopes,
    evidence_ref, reviewed_by, reviewed_at)
  values ('open_licence', 'CC-BY Diagram Set', 'approved',
          enum_range(null::public.distribution_scope),
          'licences/cc-by-4.0.txt', 'rights@example.org', now())
  returning id into ok_src;
  insert into public.lesson_sources (source_type, title, rights_status)
  values ('textbook', 'Second Source, Unasked', 'unresolved')
  returning id into bad_src;

  insert into public.lesson_source_links (project_id, source_id) values
    ('00000000-0000-0000-0000-0000000000e4', ok_src),
    ('00000000-0000-0000-0000-0000000000e4', bad_src);

  if public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e4', 'single_school') then
    raise exception 'one unresolved source among two did not block publication';
  end if;
  -- An optional source does not gate: downgrade it and the lesson clears.
  update public.lesson_source_links set required = false
  where project_id = '00000000-0000-0000-0000-0000000000e4' and source_id = bad_src;
  if not public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e4', 'single_school') then
    raise exception 'an optional unresolved source still blocked publication';
  end if;
  raise notice 'ok  every REQUIRED source must permit the scope; optional ones do not gate';
end $$;

-- 8. Revocation blocks future publication, and is recorded.
do $$
declare src uuid;
begin
  select s.id into src from public.lesson_sources s
  join public.lesson_source_links l on l.source_id = s.id
  where l.project_id = '00000000-0000-0000-0000-0000000000e3';

  begin
    update public.lesson_sources set rights_status = 'revoked' where id = src;
    raise exception 'revocation was accepted with no revoked_at';
  exception when check_violation then null;
  end;

  update public.lesson_sources
  set rights_status = 'revoked', revoked_at = now(),
      revoked_reason = 'publisher withdrew permission',
      allowed_scopes = '{}'
  where id = src;

  if public.lesson_reusable_at('00000000-0000-0000-0000-0000000000e3', 'single_school') then
    raise exception 'a revoked source still permits reuse';
  end if;
  -- The lesson was already published; the record of that is not rewritten
  -- here. What revocation stops is future publication and reuse.
  update public.cloud_lesson_projects set status = 'preparing'
  where id = '00000000-0000-0000-0000-0000000000e3';
  if public.publish_cloud_lesson('00000000-0000-0000-0000-0000000000e3', 'single_school') then
    raise exception 'a revoked source still published';
  end if;
  raise notice 'ok  revocation is recorded and blocks further publication and reuse';
end $$;

-- 9. A teacher sees the rights behind their own lesson, and no others.
do $$
declare visible int;
begin
  set local role authenticated;
  perform public.test_become('user_a');
  select count(*) into visible from public.lesson_sources;
  if visible = 0 then raise exception 'the owning teacher cannot see their own sources'; end if;

  perform public.test_become('user_stranger');
  select count(*) into visible from public.lesson_sources;
  if visible <> 0 then
    raise exception 'an unrelated teacher read % rights rows', visible;
  end if;
  reset role;
  raise notice 'ok  the rights register is visible only through a teacher''''s own lessons';
end $$;

rollback;
