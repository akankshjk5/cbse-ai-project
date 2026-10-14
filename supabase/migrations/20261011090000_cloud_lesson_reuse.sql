-- Cloud-only cache and language reuse. Existing RunPod objects are untouched.
alter table public.cloud_lesson_projects add column reused_from_project_id uuid
  references public.cloud_lesson_projects(id) on delete set null;
create index cloud_lesson_reuse_source_idx on public.cloud_lesson_projects(reused_from_project_id)
  where reused_from_project_id is not null;

-- Keep the original validated reservation/limits as a private helper.
alter function public.reserve_cloud_lesson(smallint,text,text,text,smallint) set schema private;
alter function private.reserve_cloud_lesson(smallint,text,text,text,smallint) rename to reserve_cloud_lesson_uncached;
revoke all on function private.reserve_cloud_lesson_uncached(smallint,text,text,text,smallint)
  from public,anon,authenticated,service_role;

create function public.reserve_cloud_lesson(
 p_class_level smallint,p_subject text,p_topic text,p_language_code text,p_target_duration_seconds smallint default 60
) returns setof public.cloud_lesson_projects language plpgsql security definer set search_path='' as $$
declare
 v_owner text := public.clerk_user_id(); v_key text;
 v_project public.cloud_lesson_projects; v_source public.cloud_lesson_projects;
begin
 if v_owner is null then raise exception 'Sign in to generate a lesson.' using hint='cloud_lesson_auth'; end if;
 if p_class_level is null or p_class_level not between 1 and 12
 or char_length(btrim(coalesce(p_subject,''))) not between 2 and 100
 or char_length(btrim(coalesce(p_topic,''))) not between 3 and 300
 or p_language_code is null or p_language_code not in ('en-IN','hi-IN','kn-IN')
 or p_target_duration_seconds is distinct from 60 then
   raise exception 'Check the class, subject, topic and language.' using hint='cloud_lesson_invalid';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cloud_lesson_reserve:'||v_owner,0));
 v_key := p_class_level::text||'|'||lower(regexp_replace(btrim(p_subject),'\s+',' ','g'))
   ||'|'||lower(regexp_replace(btrim(p_topic),'\s+',' ','g'))||'|60';
 -- Exact completed hits and repeated clicks on active work require no new job.
 select * into v_project from public.cloud_lesson_projects
 where owner_id=v_owner and content_key=v_key and language_code=p_language_code
 and status in ('succeeded','preparing','generating_images','generating_videos','assembling')
 order by (status='succeeded') desc,created_at desc limit 1;
 if found then return next v_project; return; end if;

 -- Only audited source plans with all eight ready scenes can be reused.
 select p.* into v_source from public.cloud_lesson_projects p
 where p.owner_id=v_owner and p.content_key=v_key and p.status='succeeded' and p.reused_from_project_id is null
 and exists(select 1 from public.cloud_lesson_jobs j where j.project_id=p.id and j.kind='prepare'
   and j.status='succeeded' and jsonb_typeof(j.output_metadata->'sourcePlan')='object')
 and (select count(*) from public.cloud_lesson_scenes s where s.project_id=p.id and s.status='succeeded' and s.image_url is not null)=8
 and not exists(select 1 from public.cloud_lesson_scenes s where s.project_id=p.id and s.motion_mode='animate'
   and not exists(select 1 from public.cloud_lesson_jobs j where j.scene_id=s.id and j.kind='video' and j.status='succeeded'
     and coalesce(j.output_metadata->>'rawVideoUrl','') ~ '^https://'))
 order by p.completed_at desc limit 1;
 select * into v_project from private.reserve_cloud_lesson_uncached(
   p_class_level,p_subject,p_topic,p_language_code,p_target_duration_seconds);
 if v_source.id is not null then
   update public.cloud_lesson_projects set reused_from_project_id=v_source.id where id=v_project.id returning * into v_project;
 end if;
 return next v_project;
end; $$;
revoke all on function public.reserve_cloud_lesson(smallint,text,text,text,smallint) from public,anon,authenticated,service_role;
grant execute on function public.reserve_cloud_lesson(smallint,text,text,text,smallint) to authenticated;

-- Retain the original completion checks and transaction, then replace image
-- jobs with zero-provider-cost composition jobs when visuals are reused.
alter function public.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb) set schema private;
alter function private.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb)
 rename to complete_cloud_lesson_preparation_original;
revoke all on function private.complete_cloud_lesson_preparation_original(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb)
 from public,anon,authenticated,service_role;
create function public.complete_cloud_lesson_preparation(
 p_job_id uuid,p_worker_id text,p_title text,p_learning_objective text,p_narration_text text,
 p_narration_url text,p_narration_duration_seconds numeric,p_scenes jsonb,p_cost_usd numeric default 0,
 p_output_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_ok boolean; v_project public.cloud_lesson_projects; v_scene record; v_raw text;
begin
 v_ok := private.complete_cloud_lesson_preparation_original(p_job_id,p_worker_id,p_title,p_learning_objective,
   p_narration_text,p_narration_url,p_narration_duration_seconds,p_scenes,p_cost_usd,p_output_metadata);
 if not v_ok then return false; end if;
 select p.* into v_project from public.cloud_lesson_projects p join public.cloud_lesson_jobs j on j.project_id=p.id where j.id=p_job_id;
 if v_project.reused_from_project_id is null or v_project.status <> 'generating_images' then return true; end if;
 if not exists(select 1 from public.cloud_lesson_projects p where p.id=v_project.reused_from_project_id
   and p.owner_id=v_project.owner_id and p.status='succeeded' and p.content_key=v_project.content_key) then
   raise exception 'Visual reuse source is unavailable';
 end if;
 delete from public.cloud_lesson_jobs where project_id=v_project.id and kind='image' and status='queued';
 for v_scene in select n.id,n.scene_index,s.image_url,s.motion_mode,s.id as source_scene_id
   from public.cloud_lesson_scenes n join public.cloud_lesson_scenes s on s.scene_index=n.scene_index
   and s.project_id=v_project.reused_from_project_id where n.project_id=v_project.id
 loop
   select j.output_metadata->>'rawVideoUrl' into v_raw from public.cloud_lesson_jobs j
     where j.scene_id=v_scene.source_scene_id and j.kind='video' and j.status='succeeded';
   if v_scene.image_url is null or (v_scene.motion_mode='animate' and v_raw is null) then raise exception 'Reusable visuals are incomplete'; end if;
   update public.cloud_lesson_scenes set image_url=v_scene.image_url,motion_mode=v_scene.motion_mode,status='queued_video' where id=v_scene.id;
   insert into public.cloud_lesson_jobs(owner_id,project_id,scene_id,kind,source_image_url,max_attempts,parameters)
   values(v_project.owner_id,v_project.id,v_scene.id,'video',v_scene.image_url,2,
     jsonb_build_object('sceneIndex',v_scene.scene_index,'motionMode',v_scene.motion_mode,'clipSeconds',5,'slotSeconds',7.5,
       'reusedFromProjectId',v_project.reused_from_project_id,'reusedRawVideoUrl',v_raw));
 end loop;
 update public.cloud_lesson_projects set status='generating_videos' where id=v_project.id;
 return true;
end; $$;
revoke all on function public.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.complete_cloud_lesson_preparation(uuid,text,text,text,text,text,numeric,jsonb,numeric,jsonb) to service_role;
