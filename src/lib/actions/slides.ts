'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { motionSchema } from '@agents/motion';

import { requireUserId } from '@/lib/auth/session';
import { setSlideMedia, setSlideMotion } from '@/lib/data/slides';
import { createClient } from '@/lib/supabase/server';

/**
 * Hand edits to a built deck. One verb so far: the animation panel's save.
 *
 * Ownership is re-checked server-side inside `setSlideMotion` even though the
 * panel only renders on the user's own deck — the deck id arrives from the
 * client, so what the UI shows is a courtesy and not a control.
 */

/** More elements than any slide the pipeline produces; a larger payload is not a slide. */
const MAX_ELEMENTS = 64;

const payloadSchema = z.object({
  deckId: z.string().uuid(),
  position: z.number().int().min(0).max(500),
  /**
   * Element index (as rendered) → its new motion. Parsed with the same schema
   * the pipeline writes through, so a browser cannot put a shape in `blocks`
   * that the renderer would then have to survive.
   */
  motions: z.record(z.string().regex(/^\d+$/), motionSchema),
});

export async function updateSlideMotionAction(
  input: unknown,
): Promise<{ error: string | null }> {
  const userId = await requireUserId();

  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) return { error: 'That animation could not be read.' };

  const { deckId, position, motions } = parsed.data;
  if (Object.keys(motions).length > MAX_ELEMENTS) {
    return { error: 'That slide has more elements than this can edit.' };
  }

  try {
    await setSlideMotion(userId, deckId, position, motions);

    revalidatePath(`/app/decks/${deckId}`);
    return { error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slides] motion save failed for ${deckId} slide ${position}: ${message}`);
    return { error: 'Could not save the animation.' };
  }
}

const mediaPayloadSchema = z.object({
  jobId: z.string().uuid(),
});

export async function updateSlideMediaAction(input: unknown): Promise<{ error: string | null }> {
  const userId = await requireUserId();
  const parsed = mediaPayloadSchema.safeParse(input);
  if (!parsed.success) return { error: 'That media result could not be read.' };
  try {
    const supabase = await createClient();
    const { data: job, error } = await supabase
      .from('deck_media_jobs')
      .select('owner_id, deck_id, slide_id, target_block, kind, status, output_url')
      .eq('id', parsed.data.jobId)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (
      !job || job.status !== 'succeeded' || !job.output_url || !job.deck_id ||
      !job.slide_id || job.target_block === null
    ) {
      throw new Error('The media job is not ready to attach');
    }
    await setSlideMedia(
      userId,
      job.deck_id,
      job.slide_id,
      job.target_block,
      job.kind as 'image' | 'video',
      job.output_url,
    );
    revalidatePath(`/app/decks/${job.deck_id}`);
    return { error: null };
  } catch (error) {
    console.error('[slides] media save failed', error);
    return { error: 'The generated media finished, but could not be attached to the slide.' };
  }
}
