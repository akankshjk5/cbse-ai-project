-- Storage tenant isolation for cloud-lesson-assets.
--
--   npm run test:db
--
-- The bucket is still PUBLIC, so these properties do not describe what a
-- browser can fetch today: a public bucket serves reads through an endpoint
-- that never consults RLS. They describe whether the policies would hold the
-- moment it is made private, which is the question that decides whether the
-- flip is safe.
--
-- Nothing here makes an existing public URL private, and no property in this
-- file should ever be cited as evidence that it did.

begin;

-- Two teachers, one lesson each, one object each.
select public.test_become('teacher_alice');
do $$
declare p uuid;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Alice Lesson', 'en-IN', 60::smallint, 'illustrated');
  insert into storage.objects (bucket_id, name, owner)
  values ('cloud-lesson-assets', p::text || '/deck/alice-deck.pptx', null);
  insert into storage.objects (bucket_id, name, owner)
  values ('cloud-lesson-assets', p::text || '/media/alice-scene.mp4', null);
  raise notice 'ok  alice has a lesson with two objects';
end $$;

select public.test_become('teacher_bob');
do $$
declare p uuid;
begin
  select id into p from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Bob Lesson', 'en-IN', 60::smallint, 'illustrated');
  insert into storage.objects (bucket_id, name, owner)
  values ('cloud-lesson-assets', p::text || '/deck/bob-deck.pptx', null);
  raise notice 'ok  bob has a lesson with one object';
end $$;

-- 1. A teacher sees their own objects. A policy that denied the owner would be
--    an outage dressed as security.
select public.test_become('teacher_alice');
do $$
declare n int;
begin
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'cloud-lesson-assets' and name like '%alice%';
  reset role;
  if n <> 2 then
    raise exception 'alice sees % of her own 2 objects', n;
  end if;
  raise notice 'ok  a teacher can read the objects of a lesson they own';
end $$;

-- 2. The property the flip turns on: a teacher cannot read another teacher's
--    object, even knowing its exact name.
select public.test_become('teacher_alice');
do $$
declare n int;
begin
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'cloud-lesson-assets' and name like '%bob%';
  reset role;
  if n <> 0 then
    raise exception 'alice can read % of bob''s objects', n;
  end if;
  raise notice 'ok  a teacher cannot read another teacher''s object';
end $$;

-- 3. Guessing a well-formed name under someone else's project id does not
--    help: ownership comes from the join, not from the path being plausible.
select public.test_become('teacher_bob');
do $$
declare alice_project uuid; n int;
begin
  select (storage.foldername(name))[1]::uuid into alice_project
    from storage.objects
   where bucket_id = 'cloud-lesson-assets' and name like '%alice-deck%';
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'cloud-lesson-assets'
     and name = alice_project::text || '/deck/alice-deck.pptx';
  reset role;
  if n <> 0 then
    raise exception 'bob read alice''s object by naming it exactly';
  end if;
  raise notice 'ok  naming another teacher''s object exactly does not grant access';
end $$;

-- 4. An object at the bucket root belongs to nobody.
--
--    Not because of null handling: foldername('stray.pptx') returns
--    {'stray.pptx'}, so the first segment is the filename itself. The join
--    fails because a project UUID never equals a filename. Checked anyway --
--    an object can reach the root through a worker bug or a hand upload, and
--    "readable by nobody" is the only safe answer for one whose owner cannot
--    be established.
select public.test_become('teacher_alice');
do $$
declare n int;
begin
  insert into storage.objects (bucket_id, name, owner)
  values ('cloud-lesson-assets', 'stray-at-the-root.pptx', null);
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'cloud-lesson-assets' and name = 'stray-at-the-root.pptx';
  reset role;
  if n <> 0 then
    raise exception 'an object at the bucket root was readable';
  end if;
  raise notice 'ok  an object with no project folder is readable by nobody';
end $$;

-- 5. A signed-out caller reads nothing. clerk_user_id() is NULL then, so the
--    join cannot match, and `anon` has no policy of its own.
do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{}', true);
  set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'cloud-lesson-assets';
  reset role;
  if n <> 0 then
    raise exception 'a caller with no user id read % objects', n;
  end if;
  raise notice 'ok  a signed-out caller reads nothing from the bucket';
end $$;

-- 6. The policies exist at all, by name. A migration that silently failed to
--    create them would make every property above pass for the wrong reason:
--    with RLS on and no policy, a non-superuser sees nothing either.
do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'cloud-lesson-assets:%';
  if n < 4 then
    raise exception 'expected 4 cloud-lesson-assets policies, found %', n;
  end if;
  raise notice 'ok  the four cloud-lesson-assets policies exist by name';
end $$;

-- 7. And the bucket is still public. Asserted so that nobody reads this file
--    as evidence that the objects are private: they are not, and the flip is a
--    separate, authorised step.
do $$
declare is_public boolean;
begin
  select public into is_public from storage.buckets where id = 'cloud-lesson-assets';
  if is_public is not true then
    raise exception 'the bucket is no longer public: this file''s header, '
      'docs/private-buckets-migration.md and every report that cites them '
      'need updating together';
  end if;
  raise notice 'ok  the bucket is STILL PUBLIC; these policies are the prerequisite, not the flip';
end $$;

rollback;
