import { NextResponse } from 'next/server';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { cloudLessonCache } from '@/lib/data/cloud-lessons';
import { CreateCloudLessonSchema } from '@/lib/videos/cloud-lesson-contracts';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
export async function GET(request: Request) {
  try { const owner = await requireUserIdOrThrow(); const params = new URL(request.url).searchParams;
    const input = CreateCloudLessonSchema.parse({ classLevel: Number(params.get('classLevel')),
      subject: params.get('subject'), topic: params.get('topic'), languageCode: params.get('languageCode'), durationSeconds: params.has('durationSeconds') ? Number(params.get('durationSeconds')) : undefined, visualStyle: params.get('visualStyle') ?? undefined });
    return NextResponse.json(await cloudLessonCache(owner, input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return cloudLessonApiError(error); }
}
