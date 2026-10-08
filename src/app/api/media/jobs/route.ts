import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { assertDeckOwner } from '@/lib/data/decks';
import { CreateMediaJobSchema, MediaJobSchema, resolveMediaParameters } from '@/lib/media/contracts';
import {
  authenticatedMediaClient,
  isAllowedMediaSourceUrl,
  MEDIA_JOB_PUBLIC_COLUMNS,
} from '@/lib/media/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const auth = await authenticatedMediaClient();
    const input = CreateMediaJobSchema.parse(await request.json());
    await assertDeckOwner(auth.userId, input.deckId);

    if (input.sourceImageUrl && !isAllowedMediaSourceUrl(input.sourceImageUrl)) {
      return NextResponse.json(
        { error: 'The source image must be in Lumina-owned storage.' },
        { status: 400 },
      );
    }

    const { data, error } = await auth.supabase
      .from('deck_media_jobs')
      .insert({
        owner_id: auth.userId,
        deck_id: input.deckId,
        slide_id: input.slideId ?? null,
        target_block: input.targetBlock ?? null,
        kind: input.kind,
        profile: input.profile,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        source_image_url: input.sourceImageUrl ?? null,
        parameters: resolveMediaParameters(input.profile, input.parameters),
      })
      .select(MEDIA_JOB_PUBLIC_COLUMNS)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ job: MediaJobSchema.parse(data) }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid media job', issues: error.flatten() },
        { status: 400 },
      );
    }
    console.error('[media] create job failed', error);
    return NextResponse.json({ error: 'Could not create the media job.' }, { status: 500 });
  }
}
export async function GET(request: Request) {
  try {
    const auth = await authenticatedMediaClient();
    const requested = Number(new URL(request.url).searchParams.get('limit') ?? 20);
    const limit = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.trunc(requested))) : 20;
    const { data, error } = await auth.supabase
      .from('deck_media_jobs')
      .select(MEDIA_JOB_PUBLIC_COLUMNS)
      .eq('owner_id', auth.userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return NextResponse.json({ jobs: MediaJobSchema.array().parse(data ?? []) });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[media] list jobs failed', error);
    return NextResponse.json({ error: 'Could not load media jobs.' }, { status: 500 });
  }
}
