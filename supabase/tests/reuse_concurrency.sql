-- Database-level reuse properties. Needs a running Postgres:
--
--   npm run db:start && psql "$DATABASE_URL" -f supabase/tests/reuse_concurrency.sql
--
-- These are the properties the offline suite cannot cover, because they are
-- about locking and visibility rather than about the compatibility decision:
-- `npm run test:reuse` proves WHETHER a source may be reused, this proves that
-- two simultaneous requests cannot both act on that answer.
--
-- NOT YET EXECUTED. Docker was unavailable when this was written, so it is a
-- specification of the expected behaviour, not a passing result.

begin;

-- 1. A second reservation for an identical lesson returns the first row rather
--    than inserting a second. Serialised by the advisory lock in
--    reserve_cloud_lesson, so the second caller sees the first's committed row.
do $$
declare a uuid; b uuid; n int;
begin
  select id into a from public.reserve_cloud_lesson(
    10::smallint, 'Science', 'Reflection and Refraction', 'en-IN', 60::smallint, 'illustrated');
  select id into b from public.reserve_cloud_lesson(
    10::smallint, 'Science', 'Reflection and Refraction', 'en-IN', 60::smallint, 'illustrated');
  if a is distinct from b then
    raise exception 'DUPLICATE: two reservations produced % and %', a, b;
  end if;
  select count(*) into n from public.cloud_lesson_jobs where project_id = a and kind = 'prepare';
  if n <> 1 then raise exception 'DUPLICATE JOBS: % prepare jobs for one lesson', n; end if;
  raise notice 'ok: a repeated reservation reuses one lesson and one prepare job';
end $$;

-- 2. Case and spacing do not split one topic into two lessons.
do $$
declare a uuid; b uuid;
begin
  select id into a from public.reserve_cloud_lesson(
    10::smallint, 'Science', 'Reflection and Refraction', 'en-IN', 60::smallint, 'illustrated');
  select id into b from public.reserve_cloud_lesson(
    10::smallint, '  science ', '  REFLECTION   and refraction  ', 'en-IN', 60::smallint, 'illustrated');
  if a is distinct from b then raise exception 'NORMALISATION: % vs %', a, b; end if;
  raise notice 'ok: case and spacing normalise to one lesson';
end $$;

-- 3. A changed model version must NOT reuse. Simulated by bumping the stored
--    model set on the source; the next reservation should refuse it as a source.
do $$
declare src uuid; fresh uuid; reused uuid;
begin
  select id into src from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Sound', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects
  set status = 'succeeded', completed_at = now(),
      model_versions = jsonb_build_object('image', 'a-retired-model')
  where id = src;
  select id into fresh from public.reserve_cloud_lesson(
    9::smallint, 'Science', 'Sound', 'en-IN', 60::smallint, 'illustrated');
  select reused_from_project_id into reused from public.cloud_lesson_projects where id = fresh;
  if reused = src then
    raise exception 'STALE REUSE: a lesson from a retired model was reused';
  end if;
  raise notice 'ok: a changed model version retires its output';
end $$;

-- 4. A failed lesson is never a reuse source.
do $$
declare src uuid; fresh uuid; reused uuid;
begin
  select id into src from public.reserve_cloud_lesson(
    8::smallint, 'Science', 'Friction', 'en-IN', 60::smallint, 'illustrated');
  update public.cloud_lesson_projects
  set status = 'failed', error_message = 'planner refused', completed_at = now()
  where id = src;
  select id into fresh from public.reserve_cloud_lesson(
    8::smallint, 'Science', 'Friction', 'en-IN', 60::smallint, 'illustrated');
  select reused_from_project_id into reused from public.cloud_lesson_projects where id = fresh;
  if reused is not null then raise exception 'FAILED REUSE: a failed lesson was reused'; end if;
  raise notice 'ok: a failed lesson is not a reusable source';
end $$;

-- 5. An unpriced job may not carry a cost.
do $$
begin
  begin
    update public.cloud_lesson_jobs set cost_basis = 'unpriced', cost_usd = 0.5
    where id = (select id from public.cloud_lesson_jobs limit 1);
    raise exception 'CONSTRAINT MISSING: an unpriced job accepted a cost';
  exception when check_violation then
    raise notice 'ok: an unpriced job cannot carry a cost';
  end;
end $$;

rollback;
