-- Storybook, cheaper and cleaner (cloud engine only; nothing else changes).
--
-- 1. At most 2 Higgsfield-animated scenes in a 60-second storybook lesson and
--    1 in a 30-second one (was 3 and 2). Every other shot still gets the
--    compositor's free camera move and dissolves.
-- 2. The engraving style no longer asks the image model for a vignette: it
--    drew one as a rounded dark frame, which the picture checker rightly
--    flagged as "not full-frame". The compositor now adds one identical
--    vignette, grain and paper finish to every frame instead.
--
-- Shots per scene stay 2-3 in the database; the prep worker now plans exactly
-- 2 (one picture fewer per scene where the director used to choose 3).

create or replace function private.cloud_lesson_storybook_animation_cap(p_scene_count integer) returns integer
language sql immutable set search_path = '' as $$
  select case when p_scene_count <= 4 then 1 else 2 end
$$;

create or replace function private.cloud_lesson_storybook_style() returns text
language sql immutable set search_path = '' as $$
  select 'Black-and-white pen-and-ink engraving illustration in the manner of a nineteenth-century book plate: fine cross-hatching and stippled shading, crisp confident linework, strong contrast, printed on aged cream sepia paper. The drawing runs to every edge of the frame with no border, frame, rounded corners or vignette, and one clear focal point. No text, letters, numbers, captions, banners, labels or watermark.'::text
$$;

revoke all on function private.cloud_lesson_storybook_animation_cap(integer) from public, anon, authenticated;
revoke all on function private.cloud_lesson_storybook_style() from public, anon, authenticated;

create or replace function private.cloud_lesson_storybook_negative() returns text
language sql immutable set search_path = '' as $$
  select 'text, writing, letters, numbers, captions, banners, labels, watermark, logo, border, frame, rounded corners, vignette, colour, color photograph, photorealistic, 3D render, flat vector cartoon, distorted anatomy, extra fingers, duplicate subjects, low quality'::text
$$;
revoke all on function private.cloud_lesson_storybook_negative() from public, anon, authenticated;
