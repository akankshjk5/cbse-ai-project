import { NextResponse } from 'next/server';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { CreateCloudLessonSchema, CloudLessonProjectSchema } from '@/lib/videos/cloud-lesson-contracts';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
import { admitGeneration } from '@/lib/generation/admission';
export async function GET() {
  try { const owner = await requireUserIdOrThrow(); return NextResponse.json({ projects: await listCloudLessons(owner) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return cloudLessonApiError(error); }
}
export async function POST(request: Request) {
  try {
    await requireUserIdOrThrow();
    const input = CreateCloudLessonSchema.parse(await request.json());
    // Refuse before reserving: a lesson whose stages this deployment cannot run
    // should fail at the request, not minutes later inside a worker. The
    // factories in src/lib/cloud-lesson/ remain the control over spending.
    const admission = admitGeneration();
    if (!admission.admitted) {
      return NextResponse.json({ error: admission.reason }, { status: 503 });
    }
    const client = await createClient();
    const { data, error } = await client.rpc('reserve_cloud_lesson', { p_class_level: input.classLevel,
      p_subject: input.subject, p_topic: input.topic, p_language_code: input.languageCode, p_target_duration_seconds: input.durationSeconds, p_visual_style: input.visualStyle });
    if (error) throw error;
    const project = CloudLessonProjectSchema.parse(data?.[0]);
    return NextResponse.json({
      project,
      cached: project.status === 'succeeded',
      reusedVisuals: !!project.reused_from_project_id,
      // Which provider will serve each stage, so a caller can see before any
      // work happens whether this lesson will spend at a third party.
      generator: admission.generator,
      paidStages: admission.paidStages,
    }, { status: project.status === 'succeeded' ? 200 : 202 });
  } catch (error) { return cloudLessonApiError(error); }
}
