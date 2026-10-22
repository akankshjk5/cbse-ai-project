-- The one authorisation rule, asserted in isolation.
--
--   npm run test:db
--
-- keyframe_reuse.sql and clip_reuse.sql prove the rule holds through two
-- specific lookups. This proves the rule itself, as a truth table, so a future
-- caller can be checked against it without re-deriving what it ought to say.
--
-- The case worth having a test for is the fourth row: two teachers who belong
-- to no school are NOT colleagues. Without the `p_school is not null` guard
-- `null = null` is null, not true, so SQL happens to get this right -- but a
-- copy written as `coalesce(p_school, c_school) = ...` or with an `is not
-- distinct from` would get it wrong and leak. Five copies of this rule existed
-- before 20261023090000; this is what they all have to agree on.

begin;

-- 1. The truth table, exhaustively over the shapes that matter.
do $$
declare
  a text := 'teacher_a';
  b text := 'teacher_b';
  s1 uuid := '11111111-1111-4111-8111-111111111111';
  s2 uuid := '22222222-2222-4222-8222-222222222222';
begin
  -- Own work, whatever the schools say.
  if not private.reuse_scope_ok(a, null, a, null) then
    raise exception 'a teacher cannot reuse their own schoolless work';
  end if;
  if not private.reuse_scope_ok(a, s1, a, s1) then
    raise exception 'a teacher cannot reuse their own work inside a school';
  end if;
  if not private.reuse_scope_ok(a, s1, a, s2) then
    raise exception 'a teacher cannot reuse their own work after changing school';
  end if;
  if not private.reuse_scope_ok(a, null, a, s1) then
    raise exception 'a teacher cannot reuse their own work from before joining a school';
  end if;

  -- A colleague, same real school.
  if not private.reuse_scope_ok(a, s1, b, s1) then
    raise exception 'a colleague in the same school cannot be reused from';
  end if;

  -- A stranger in a different school.
  if private.reuse_scope_ok(a, s1, b, s2) then
    raise exception 'LEAK: a different school was treated as the same one';
  end if;

  -- THE ONE THAT MATTERS: no school on either side is not a match.
  if private.reuse_scope_ok(a, null, b, null) then
    raise exception 'LEAK: two schoolless teachers were treated as colleagues';
  end if;

  -- Asymmetric nulls, both directions.
  if private.reuse_scope_ok(a, null, b, s1) then
    raise exception 'LEAK: a schoolless caller reused a school''s work';
  end if;
  if private.reuse_scope_ok(a, s1, b, null) then
    raise exception 'LEAK: a school''s caller reused schoolless work';
  end if;

  raise notice 'ok  the reuse scope truth table holds for own, colleague, stranger and null';
end $$;

-- 2. It is inlinable. `language sql` + `immutable` is what keeps this a join
--    predicate the planner can work with; a plpgsql version would become a
--    per-row function call and turn an indexed lookup into a scan.
do $$
declare v_lang text; v_volatility char;
begin
  select l.lanname, p.provolatile into v_lang, v_volatility
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'reuse_scope_ok';

  if v_lang <> 'sql' then
    raise exception 'reuse_scope_ok is %, not sql, so it will not inline', v_lang;
  end if;
  if v_volatility <> 'i' then
    raise exception 'reuse_scope_ok is volatility %, not immutable', v_volatility;
  end if;
  raise notice 'ok  the predicate is plain SQL and immutable, so it inlines';
end $$;

-- 3. Not reachable by a client. It is an authorisation primitive; an
--    authenticated caller able to probe it learns which owners share a school.
do $$
begin
  if pg_catalog.has_function_privilege('authenticated',
       'private.reuse_scope_ok(text, uuid, text, uuid)', 'execute') then
    raise exception 'authenticated can execute the authorisation predicate';
  end if;
  if pg_catalog.has_function_privilege('anon',
       'private.reuse_scope_ok(text, uuid, text, uuid)', 'execute') then
    raise exception 'anon can execute the authorisation predicate';
  end if;
  raise notice 'ok  the predicate is not executable by anon or authenticated';
end $$;

-- 4. Both lookups actually call it, rather than keeping a private copy. A
--    refactor that extracted the rule and left the old predicate behind would
--    pass every behavioural test and tidy nothing.
do $$
declare v_src text; n int := 0;
begin
  foreach v_src in array array[
    pg_catalog.pg_get_functiondef('public.cloud_lesson_reusable_keyframe(uuid)'::regprocedure),
    pg_catalog.pg_get_functiondef('public.cloud_lesson_reusable_clip(uuid)'::regprocedure)
  ]
  loop
    if v_src not like '%reuse_scope_ok%' then
      raise exception 'a reuse lookup does not call private.reuse_scope_ok';
    end if;
    -- And no leftover inline copy of the rule.
    if v_src like '%school_id = v_project.school_id%' then
      raise exception 'a reuse lookup still carries its own copy of the scope rule';
    end if;
    n := n + 1;
  end loop;
  if n <> 2 then raise exception 'expected to check 2 lookups, checked %', n; end if;
  raise notice 'ok  both reuse lookups call the shared predicate and keep no copy';
end $$;

rollback;
