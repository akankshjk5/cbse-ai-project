-- ─────────────────────────────────────────────────────────────────────────────
-- 0801 · Deck generation inputs
--
-- Structured fields captured by the "Create PPTX" form, alongside the existing
-- free-text topic/audience/tone/language columns from migration 0300. These
-- are inputs to the (not-yet-built) generation pipeline, not derived data, so
-- they get real columns rather than living in `metadata` jsonb.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.decks
  add column if not exists grade_level integer check (grade_level between 1 and 10),
  add column if not exists subject text,
  add column if not exists board text not null default 'CBSE',
  add column if not exists requested_slide_count integer
    check (requested_slide_count is null or requested_slide_count between 1 and 60);
