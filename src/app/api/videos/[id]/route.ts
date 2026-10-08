import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { MediaJobSchema } from '@/lib/media/contracts';
import { MEDIA_JOB_PUBLIC_COLUMNS } from '@/lib/media/server';
import { createClient } from '@/lib/supabase/server';
import { VideoProjectSchema } from '@/lib/videos/contracts';

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const { data: project, error } = await supabase
      .from('video_projects')
      .select('*')
      .eq('id', id.data)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error || !project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    const jobId = project.status === 'generating_video'
      ? project.video_job_id
      : project.image_job_id;
    let activeJob = null;
    if (jobId) {
      const { data } = await supabase
        .from('deck_media_jobs')
        .select(MEDIA_JOB_PUBLIC_COLUMNS)
        .eq('id', jobId)
        .eq('owner_id', userId)
        .maybeSingle();
      if (data) activeJob = MediaJobSchema.parse(data);
    }

    return NextResponse.json({ project: VideoProjectSchema.parse(project), activeJob });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: 'Could not load this video.' }, { status: 500 });
  }
}
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const { data: project } = await supabase
      .from('video_projects')
      .select('status, image_job_id, video_job_id')
      .eq('id', id.data)
      .eq('owner_id', userId)
      .maybeSingle();
    if (!project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    const jobId = project.status === 'generating_video'
      ? project.video_job_id
      : project.image_job_id;
    if (!jobId || !['generating_image', 'generating_video'].includes(project.status)) {
      return NextResponse.json({ error: 'This video is not generating.' }, { status: 409 });
    }
    const { error } = await supabase.rpc('request_deck_media_job_cancel', { p_job_id: jobId });
    if (error) throw new Error(error.message);
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: 'Could not cancel this video.' }, { status: 500 });
  }
}
