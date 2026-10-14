import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { CloudLessonProjectSchema, CloudLessonSceneSchema, CloudLessonJobProgressSchema,
  CLOUD_LESSON_JOB_PUBLIC_COLUMNS, type CreateCloudLessonInput } from '@/lib/videos/cloud-lesson-contracts';
import { cloudLessonKeys, cloudLessonProgress } from '@/lib/cloud-lesson/progress';

export async function listCloudLessons(ownerId: string) {
  const client = await createClient();
  const { data, error } = await client.from('cloud_lesson_projects').select('*').eq('owner_id', ownerId)
    .order('created_at', { ascending: false }).limit(30);
  if (error) throw new Error('Could not load cloud lessons.');
  return CloudLessonProjectSchema.array().parse(data ?? []);
}
export async function loadCloudLesson(ownerId: string, id: string) {
  const client = await createClient();
  const result = await client.from('cloud_lesson_projects').select('*').eq('id', id).eq('owner_id', ownerId).maybeSingle();
  if (result.error) throw new Error('Could not load the lesson.');
  if (!result.data) return null;
  const [scenes, jobs] = await Promise.all([
    client.from('cloud_lesson_scenes').select('*').eq('project_id', id).order('scene_index'),
    client.from('cloud_lesson_jobs').select(CLOUD_LESSON_JOB_PUBLIC_COLUMNS).eq('project_id', id).eq('owner_id', ownerId).order('created_at'),
  ]);
  if (scenes.error || jobs.error) throw new Error('Could not load lesson progress.');
  const project = CloudLessonProjectSchema.parse(result.data);
  const parsedJobs = CloudLessonJobProgressSchema.array().parse(jobs.data ?? []);
  return { project, scenes: CloudLessonSceneSchema.array().parse(scenes.data ?? []), jobs: parsedJobs,
    ...cloudLessonProgress(project, parsedJobs) };
}
export async function cloudLessonCache(ownerId: string, input: CreateCloudLessonInput) {
  const client = await createClient();
  const { contentKey } = cloudLessonKeys(input);
  const { data, error } = await client.from('cloud_lesson_projects').select('*').eq('owner_id', ownerId)
    .eq('content_key', contentKey).eq('visual_style', input.visualStyle ?? 'illustrated').eq('status', 'succeeded').order('completed_at', { ascending: false }).limit(30);
  if (error) throw new Error('Could not check existing lessons.');
  const projects = CloudLessonProjectSchema.array().parse(data ?? []);
  const exact = projects.find(p => p.language_code === input.languageCode) ?? null;
  // A source plan is required; early lessons created before Step 7 cannot reuse visuals.
  let reusable = null;
  for (const project of projects.filter(p => p.language_code !== input.languageCode && !p.reused_from_project_id)) {
    const { data: preparation, error: planError } = await client.from('cloud_lesson_jobs').select('output_metadata')
      .eq('owner_id', ownerId).eq('project_id', project.id).eq('kind', 'prepare').eq('status', 'succeeded').maybeSingle();
    if (planError) throw new Error('Could not check reusable lessons.');
    const metadata = preparation?.output_metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.sourcePlan) { reusable = project; break; }
  }
  return { exact, reusable };
}
export type CloudLessonDetail = NonNullable<Awaited<ReturnType<typeof loadCloudLesson>>>;
