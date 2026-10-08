import 'server-only';

import { motionSchema, type Motion } from '@agents/motion';

import { assertDeckOwner } from '@/lib/data/decks';
import { parseBlocksWithIndex } from '@/lib/slides/blocks';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

/**
 * Slide-level writes the user makes by hand.
 *
 * The pipeline writes slides wholesale on the service-role client
 * (`replaceSlides`); this is the other direction — one person changing one
 * thing about a deck they own — so it runs on the **Clerk-scoped** client and
 * lets RLS be the boundary, with the usual explicit `deck_id` filter on top.
 *
 * Note what a hand edit does NOT get: `replaceSlides` still deletes and
 * reinserts every slide on a rebuild, so a regenerated deck loses hand-set
 * motion along with everything else about its old slides. That is the honest
 * behaviour for now — a rebuild produces different elements, and there is no
 * identity to carry an animation across on. Worth revisiting only when
 * elements get stable ids.
 */

/**
 * Replaces the motion on some of one slide's elements.
 *
 * Keyed by the element's index in the RENDERED slide, which
 * `parseBlocksWithIndex` maps back to its position in the stored array — the
 * two differ the moment a malformed block is dropped, and an edit landing one
 * element over is the kind of bug nobody reports because it looks like a
 * mistake they made themselves.
 *
 * Only `motion` is touched. The rest of each block is written back byte for
 * byte, so this cannot become an accidental round-trip through a schema that
 * has moved on since the deck was built.
 */
export async function setSlideMotion(
  userId: string,
  deckId: string,
  position: number,
  motions: Record<number, unknown>,
): Promise<void> {
  // The second layer this file's neighbours keep: `slides` has no `owner_id`
  // to filter on, so the explicit check is a lookup on the parent deck rather
  // than an extra `.eq`. RLS (`is_deck_owner`) is still the real boundary.
  await assertDeckOwner(userId, deckId);

  const supabase = await createClient();

  const { data: slide, error: readError } = await supabase
    .from('slides')
    .select('id, blocks')
    .eq('deck_id', deckId)
    .eq('position', position)
    .maybeSingle();

  if (readError) throw new Error(`setSlideMotion read failed: ${readError.message}`);
  if (!slide) throw new Error(`Slide ${position} of deck ${deckId} does not exist`);

  const stored = Array.isArray(slide.blocks) ? [...(slide.blocks as unknown[])] : [];
  const rendered = parseBlocksWithIndex(slide.blocks);

  let changed = 0;
  for (const [key, value] of Object.entries(motions)) {
    const elementId = Number(key);
    const target = rendered[elementId];
    // An index the slide does not have is a stale panel, not an error worth
    // failing the whole save over — the other elements' edits are still good.
    if (!target) continue;

    const entry = stored[target.index];
    if (typeof entry !== 'object' || entry === null) continue;

    // Model output and browser input alike: validated before it is stored,
    // never interpolated in trusting it.
    const motion: Motion = motionSchema.parse(value ?? {});
    stored[target.index] = { ...(entry as Record<string, unknown>), motion };
    changed += 1;
  }

  if (changed === 0) return;

  const { error } = await supabase
    .from('slides')
    .update({ blocks: stored as unknown as Json })
    .eq('id', slide.id)
    .eq('deck_id', deckId);

  if (error) throw new Error(`setSlideMotion failed: ${error.message}`);
}

/** Apply a completed GPU result to one image element without trusting ownership from the client. */
export async function setSlideMedia(
  userId: string,
  deckId: string,
  slideId: string,
  elementId: number,
  kind: 'image' | 'video',
  url: string,
): Promise<void> {
  await assertDeckOwner(userId, deckId);
  const supabase = await createClient();
  const { data: slide, error: readError } = await supabase
    .from('slides')
    .select('id, blocks')
    .eq('id', slideId)
    .eq('deck_id', deckId)
    .maybeSingle();
  if (readError) throw new Error(`setSlideMedia read failed: ${readError.message}`);
  if (!slide) throw new Error(`Slide ${slideId} of deck ${deckId} does not exist`);

  const stored = Array.isArray(slide.blocks) ? [...(slide.blocks as unknown[])] : [];
  const target = parseBlocksWithIndex(slide.blocks)[elementId];
  if (!target) throw new Error('The selected slide element no longer exists');
  const entry = stored[target.index];
  if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'image') {
    throw new Error('The selected element is not an image');
  }

  const next = { ...(entry as Record<string, unknown>) };
  if (kind === 'image') {
    next.imageUrl = url;
    delete next.videoUrl;
  } else {
    next.videoUrl = url;
  }
  stored[target.index] = next;

  const { error } = await supabase
    .from('slides')
    .update({ blocks: stored as unknown as Json })
    .eq('id', slide.id)
    .eq('deck_id', deckId);
  if (error) throw new Error(`setSlideMedia failed: ${error.message}`);
}
