import { NextResponse } from 'next/server';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { CreateCloudLessonSchema, CloudLessonProjectSchema } from '@/lib/videos/cloud-lesson-contracts';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
export async function GET() {
  try { const owner = await requireUserIdOrThrow(); return NextResponse.json({ projects: await listCloudLessons(owner) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return cloudLessonApiError(error); }
}
export async function POST(request: Request) {
  try {
    await requireUserIdOrThrow();
    const input = CreateCloudLessonSchema.parse(await request.json());
    const client = await createClient();
    const { data, error } = await client.rpc('reserve_cloud_lesson', { p_class_level: input.classLevel,
      p_subject: input.subject, p_topic: input.topic, p_language_code: input.languageCode, p_target_duration_seconds: input.durationSeconds, p_visual_style: input.visualStyle });
    if (error) throw error;
    const project = CloudLessonProjectSchema.parse(data?.[0]);
    return NextResponse.json({ project, cached: project.status === 'succeeded', reusedVisuals: !!project.reused_from_project_id },
      { status: project.status === 'succeeded' ? 200 : 202 });
  } catch (error) { return cloudLessonApiError(error); }
}
