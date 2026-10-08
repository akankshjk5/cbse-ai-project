import { NextResponse } from 'next/server';
import { z } from 'zod';

import { MediaJobSchema } from '@/lib/media/contracts';
import { authenticatedMediaClient } from '@/lib/media/server';

const idSchema = z.string().uuid();

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticatedMediaClient();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid job id.' }, { status: 400 });
    const { data, error } = await auth.supabase.rpc('retry_deck_media_job', {
      p_job_id: id.data,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return NextResponse.json({ error: 'Only failed jobs can be retried.' }, { status: 409 });
    return NextResponse.json({ job: MediaJobSchema.parse(row) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: 'Could not retry the media job.' }, { status: 500 });
  }
}
