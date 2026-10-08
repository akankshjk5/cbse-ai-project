-- Make standalone clips topic-first and expose only durations validated by the
-- serving worker. Three seconds is the fast default; five trades latency for
-- more time to show the concept.

alter table public.video_projects
  add column duration_seconds smallint not null default 3
  constraint video_projects_duration_seconds_check check (duration_seconds in (3, 5));

create or replace function public.create_video_project_v2(
  p_class_level smallint,
  p_subject text,
  p_topic text,
  p_duration_seconds smallint default 3
)
returns setof public.video_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := public.clerk_user_id();
  v_project public.video_projects;
  v_job_id uuid;
  v_subject text := trim(p_subject);
  v_topic text := trim(p_topic);
  v_subject_direction text;
  v_topic_direction text := '';
  v_image_prompt text;
  v_video_prompt text;
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  if p_class_level < 1 or p_class_level > 12 then
    raise exception 'Class must be between 1 and 12';
  end if;
  if char_length(v_subject) < 2 or char_length(v_subject) > 100 then
    raise exception 'Subject must be between 2 and 100 characters';
  end if;
  if char_length(v_topic) < 3 or char_length(v_topic) > 300 then
    raise exception 'Topic must be between 3 and 300 characters';
  end if;
  if p_duration_seconds not in (3, 5) then
    raise exception 'Duration must be 3 or 5 seconds';
  end if;

  v_subject_direction := case lower(v_subject)
    when 'computer science' then
      'Show the actual computing mechanism with topic-specific data flow, state changes, algorithms, and connected components. Do not show source code or a computer screen.'
    when 'mathematics' then
      'Show the mathematical relationship through concrete geometry, quantities, transformations, or spatial patterns without written equations.'
    when 'science' then
      'Show the real scientific mechanism, objects, forces, or cause-and-effect process with physically coherent details.'
    when 'social science' then
      'Show the specific people, place, event, system, map-like spatial relationship, or cause-and-effect central to the topic without labels.'
    when 'english' then
      'Show the specific story action, language concept, or literary idea through clear characters, objects, and visual relationships without written words.'
    when 'hindi' then
      'Show the specific story action, language concept, or literary idea through clear characters, objects, and visual relationships without written words.'
    when 'evs' then
      'Show the specific environmental system, living things, resources, and cause-and-effect relationships central to the topic.'
    else
      'Show the actual objects, mechanism, relationships, and cause-and-effect central to the topic.'
  end;

  if lower(v_subject) = 'computer science'
     and lower(v_topic) ~ '(^|[^a-z])python([^a-z]|$)' then
    v_topic_direction :=
      'Interpret Python as the programming language, not an animal. Use a visual computation pipeline with variables as data objects, functions as reusable processing modules, and control flow as connected paths.';
  end if;

  v_image_prompt := format(
    'TOPIC-FIRST educational visual. Topic: "%s". Subject: %s, Class %s. The entire frame must directly explain the topic rather than depict someone teaching it. %s %s Use one coherent widescreen 16:9 composition with a clear focal mechanism, accurate details, strong visual hierarchy, clean cinematic educational illustration, and no irrelevant decoration. No classroom, teacher, students, lecture, blackboard, whiteboard, projector, presentation slide, or talking head. No writing of any kind: no words, letters, numbers, equations, code, captions, labels, logos, UI, or watermark.',
    v_topic, v_subject, p_class_level, v_subject_direction, v_topic_direction
  );
  v_video_prompt := format(
    'Animate a single continuous %s-second educational shot that directly demonstrates the mechanism of "%s" for Class %s %s. %s %s Make the topic-specific objects change, interact, flow, or transform in a clear cause-and-effect sequence. Keep the source subject recognizable and geometry stable; use restrained camera motion so the concept remains readable. Do not turn this into a generic lesson or animate teacher gestures. No classroom, teacher, students, blackboard, projector, talking head, scene cuts, morphing, added objects, writing, words, letters, numbers, code, captions, labels, logos, UI, or watermark.',
    p_duration_seconds, v_topic, p_class_level, v_subject,
    v_subject_direction, v_topic_direction
  );

  insert into public.video_projects (
    owner_id, class_level, subject, topic, duration_seconds, image_prompt, video_prompt
  ) values (
    v_owner, p_class_level, v_subject, v_topic, p_duration_seconds,
    v_image_prompt, v_video_prompt
  ) returning * into v_project;

  insert into public.deck_media_jobs (
    owner_id, video_project_id, kind, profile, prompt, negative_prompt, parameters
  ) values (
    v_owner,
    v_project.id,
    'image',
    'image-fast',
    v_image_prompt,
    'text, writing, words, letters, numbers, equations, code, captions, labels, watermark, logo, UI, classroom, teacher, students, blackboard, whiteboard, projector, presentation slide, talking head, distorted anatomy, duplicate subjects, low quality',
    jsonb_build_object('width', 1024, 'height', 576, 'steps', 8)
  ) returning id into v_job_id;

  update public.video_projects
  set image_job_id = v_job_id
  where id = v_project.id
  returning * into v_project;

  return next v_project;
end;
$$;

revoke all on function public.create_video_project_v2(smallint, text, text, smallint)
  from public, anon;
grant execute on function public.create_video_project_v2(smallint, text, text, smallint)
  to authenticated;

-- Preserve the transactional image -> video transition while carrying the
-- selected duration into the worker's allowlisted parameters.
create or replace function public.complete_deck_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_output_url text,
  p_output_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.deck_media_jobs;
  v_project public.video_projects;
  v_video_job_id uuid;
begin
  update public.deck_media_jobs
  set status = case when cancel_requested_at is null then 'succeeded' else 'cancelled' end,
      progress = case when cancel_requested_at is null then 100 else progress end,
      output_url = case when cancel_requested_at is null then p_output_url else null end,
      output_metadata = coalesce(p_output_metadata, '{}'::jsonb),
      completed_at = now(),
      heartbeat_at = now()
  where id = p_job_id and worker_id = p_worker_id and status = 'processing'
  returning * into v_job;

  if not found then return false; end if;
  if v_job.video_project_id is null then return true; end if;

  select * into v_project
  from public.video_projects
  where id = v_job.video_project_id
  for update;

  if v_job.status = 'cancelled' then
    update public.video_projects
    set status = 'cancelled', completed_at = now()
    where id = v_project.id;
    return true;
  end if;

  if v_job.kind = 'image' then
    insert into public.deck_media_jobs (
      owner_id, video_project_id, kind, profile, prompt, negative_prompt,
      source_image_url, parameters
    ) values (
      v_project.owner_id,
      v_project.id,
      'video',
      'video-fast',
      v_project.video_prompt,
      'text, writing, words, letters, numbers, equations, code, captions, labels, watermark, logo, UI, classroom, teacher, students, blackboard, whiteboard, projector, presentation slide, talking head, scene cuts, flicker, deformation, unstable subject',
      p_output_url,
      jsonb_build_object(
        'width', 832,
        'height', 480,
        'durationSeconds', v_project.duration_seconds,
        'fps', 16,
        'steps', 20
      )
    ) returning id into v_video_job_id;

    update public.video_projects
    set status = 'generating_video',
        image_url = p_output_url,
        video_job_id = v_video_job_id,
        error_message = null
    where id = v_project.id;
  else
    update public.video_projects
    set status = 'succeeded',
        video_url = p_output_url,
        error_message = null,
        completed_at = now()
    where id = v_project.id;
  end if;

  return true;
end;
$$;

revoke all on function public.complete_deck_media_job(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_deck_media_job(uuid, text, text, jsonb)
  to service_role;
