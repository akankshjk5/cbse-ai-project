import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { CreateVideoProjectSchema, VideoProjectSchema } from '@/lib/videos/contracts';

export async function POST(request: Request) {
  try {
    await requireUserIdOrThrow();
    const input = CreateVideoProjectSchema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('create_video_project_v2', {
      p_class_level: input.classLevel,
      p_duration_seconds: input.durationSeconds,
      p_subject: input.subject,
      p_topic: input.topic,
    });
    if (error) throw new Error(error.message);
    const project = Array.isArray(data) ? data[0] : data;
    if (!project) throw new Error('Video project was not created');
    return NextResponse.json({ project: VideoProjectSchema.parse(project) }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Check the class, subject, topic and duration.' }, { status: 400 });
    }
    console.error('[videos] create failed', error);
    return NextResponse.json({ error: 'Could not start video generation.' }, { status: 500 });
  }
}
