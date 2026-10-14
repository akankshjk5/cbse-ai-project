import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { loadCloudLesson } from '@/lib/data/cloud-lessons';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { const owner = await requireUserIdOrThrow(); const id = z.string().uuid().parse((await context.params).id);
    const detail = await loadCloudLesson(owner, id);
    return detail ? NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'Lesson not found.' }, { status: 404 });
  } catch (error) { return cloudLessonApiError(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try { await requireUserIdOrThrow(); const id = z.string().uuid().parse((await context.params).id);
    const client = await createClient(); const { data, error } = await client.rpc('cancel_cloud_lesson', { p_project_id: id });
    if (error) throw error;
    return data?.length ? NextResponse.json({ cancelled: true }) : NextResponse.json({ error: 'This lesson is no longer generating.' }, { status: 409 });
  } catch (error) { return cloudLessonApiError(error); }
}
