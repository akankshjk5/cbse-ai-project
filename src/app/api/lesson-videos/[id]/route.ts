import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { canWorkerProcessLesson } from '@/lib/videos/local-ai';
import {
  LessonVideoProjectSchema,
  LessonVideoSceneSchema,
} from '@/lib/videos/lesson-contracts';
import { lessonProgressSnapshot } from '@/lib/videos/progress';

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const [projectResult, scenesResult, jobsResult] = await Promise.all([
      supabase
        .from('lesson_video_projects')
        .select('*')
        .eq('id', id.data)
        .eq('owner_id', userId)
        .maybeSingle(),
      supabase
        .from('lesson_video_scenes')
        .select('*')
        .eq('project_id', id.data)
        .order('scene_index'),
      supabase
        .from('lesson_video_jobs')
        .select('kind, scene_id, status, progress, started_at, output_metadata')
        .eq('project_id', id.data)
        .order('created_at', { ascending: true }),
    ]);
    if (projectResult.error || scenesResult.error || jobsResult.error) {
      throw new Error('Could not read the video progress from the database.');
    }
    const project = projectResult.data;
    if (!project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    const parsedProject = LessonVideoProjectSchema.parse(project);
    const parsedScenes = LessonVideoSceneSchema.array().parse(scenesResult.data ?? []);
    const snapshot = lessonProgressSnapshot(parsedProject, parsedScenes, jobsResult.data ?? []);
    const rendering = ['generating_images', 'generating_videos', 'assembling']
      .includes(parsedProject.status);
    const workerAvailable = rendering
      ? await canWorkerProcessLesson(userId, parsedProject.id)
      : true;
    const hasProcessingJob = (jobsResult.data ?? []).some((job) => job.status === 'processing');
    const waitingForWorker = rendering && !hasProcessingJob && !workerAvailable;
    return NextResponse.json({
      project: parsedProject,
      scenes: parsedScenes,
      ...snapshot,
      etaSeconds: waitingForWorker ? null : snapshot.etaSeconds,
      waitingForWorker,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] load failed', error);
    return NextResponse.json({ error: 'Could not load this lesson video.' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cancel_lesson_video_project', {
      p_project_id: id.data,
    });
    if (error) throw new Error(error.message);
    if (!data?.length) {
      return NextResponse.json({ error: 'This video is not generating.' }, { status: 409 });
    }
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] cancel failed', error);
    return NextResponse.json({ error: 'Could not cancel this video.' }, { status: 500 });
  }
}
