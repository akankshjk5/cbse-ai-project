import { NextResponse } from 'next/server';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  try {
    const userId = await requireUserIdOrThrow();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('lesson_video_projects')
      .select('id, title, status')
      .eq('owner_id', userId)
      .in('status', ['preparing', 'generating_images', 'generating_videos', 'assembling'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json({ project: data ?? null });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] active lookup failed', error);
    return NextResponse.json({ error: 'Could not load active video.' }, { status: 500 });
  }
}
