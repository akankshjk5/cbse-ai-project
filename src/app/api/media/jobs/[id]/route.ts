import { NextResponse } from 'next/server';
import { z } from 'zod';

import { MediaJobSchema } from '@/lib/media/contracts';
import { authenticatedMediaClient, MEDIA_JOB_PUBLIC_COLUMNS } from '@/lib/media/server';

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticatedMediaClient();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid job id.' }, { status: 400 });
    const { data, error } = await auth.supabase
      .from('deck_media_jobs')
      .select(MEDIA_JOB_PUBLIC_COLUMNS)
      .eq('id', id.data)
      .eq('owner_id', auth.userId)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    return NextResponse.json({ job: MediaJobSchema.parse(data) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: 'Could not load the media job.' }, { status: 500 });
  }
}
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticatedMediaClient();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid job id.' }, { status: 400 });
    const { data, error } = await auth.supabase.rpc('request_deck_media_job_cancel', {
      p_job_id: id.data,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return NextResponse.json({ error: 'Job cannot be cancelled.' }, { status: 409 });
    return NextResponse.json({ job: MediaJobSchema.parse(row) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: 'Could not cancel the media job.' }, { status: 500 });
  }
}
