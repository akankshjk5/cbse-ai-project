import 'server-only';

import { createClient, createPublicClient } from '@/lib/supabase/server';
import type { Deck, Slide, TablesInsert } from '@/lib/supabase/types';

/**
 * Deck data access.
 *
 * Two layers of protection, deliberately redundant:
 *   1. RLS — these queries run on the caller's Clerk token, so Postgres itself
 *      refuses rows owned by anyone else.
 *   2. Explicit `.eq('owner_id', userId)` filters below.
 *
 * Keep both. Either one alone is a single point of failure, and the belt-and-
 * braces version costs nothing at this scale.
 *
 * Rules for anything added here:
 *  - `userId` is a Clerk id and comes from requireUserId(), never from a request
 *    body or a route param.
 *  - Reach for createAdminClient() only in background workers with no session.
 */

export class DeckAccessError extends Error {
  constructor(deckId: string) {
    super(`Deck ${deckId} does not exist or is not owned by this user`);
    this.name = 'DeckAccessError';
  }
}

/** Decks per page in the grid. */
export const DECK_PAGE_SIZE = 24;

/**
 * One page of the caller's decks, newest first, plus how many there are.
 *
 * Paged rather than capped. The old shape took `limit = 50` and returned an
 * array, which is a silent truncation: a user with sixty decks was shown fifty
 * and told nothing, and the ten missing ones were unreachable through the UI
 * entirely. Both numbers come from one round trip — `count: 'exact'` rides
 * along with the range — and the sort is covered by
 * `decks_owner_updated_idx (owner_id, updated_at desc)`, so paging deep costs
 * the same as paging shallow.
 */
export async function listDecks(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ decks: Deck[]; total: number }> {
  const limit = options.limit ?? DECK_PAGE_SIZE;
  const offset = options.offset ?? 0;

  const supabase = await createClient();
  const { data, count, error } = await supabase
    .from('decks')
    .select('*', { count: 'exact' })
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`listDecks failed: ${error.message}`);
  return { decks: data ?? [], total: count ?? 0 };
}

/**
 * The first slide of each of `deckIds`, for card thumbnails.
 *
 * One query for the whole list rather than one per card, and only position 0 —
 * a grid of thirty decks has no use for their nine hundred slides. RLS scopes
 * it (`is_deck_owner`), and the explicit deck-id filter keeps the belt-and-
 * braces rule of this file.
 */
export async function coverSlides(deckIds: string[]): Promise<Map<string, Slide>> {
  if (deckIds.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('slides')
    .select('*')
    .in('deck_id', deckIds)
    .eq('position', 0);

  if (error) throw new Error(`coverSlides failed: ${error.message}`);

  return new Map((data ?? []).map((slide) => [slide.deck_id, slide]));
}

/** A deck the caller owns, with its slides in order. Null so callers can notFound(). */
export async function getOwnedDeck(
  userId: string,
  deckId: string,
): Promise<(Deck & { slides: Slide[] }) | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('decks')
    .select('*, slides(*)')
    .eq('id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (error) throw new Error(`getOwnedDeck failed: ${error.message}`);
  if (!data) return null;

  const { slides, ...deck } = data as Deck & { slides: Slide[] };
  return { ...deck, slides: [...slides].sort((a, b) => a.position - b.position) };
}

/** A link-shared deck for the public viewer. Anonymous client: RLS is the check. */
export async function getSharedDeck(deckId: string) {
  const supabase = createPublicClient();
  const { data, error } = await supabase
    .from('decks')
    .select('*, slides(*)')
    .eq('id', deckId)
    .maybeSingle();

  if (error) throw new Error(`getSharedDeck failed: ${error.message}`);
  return data;
}

/** Throws unless `userId` owns `deckId`. Call before any write to a child row. */
export async function assertDeckOwner(userId: string, deckId: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('decks')
    .select('id')
    .eq('id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (error) throw new Error(`assertDeckOwner failed: ${error.message}`);
  if (!data) throw new DeckAccessError(deckId);
}

export async function createDeck(
  userId: string,
  input: Omit<TablesInsert<'decks'>, 'owner_id' | 'id'>,
): Promise<Deck> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('decks')
    // owner_id comes from the session; the Omit above makes passing it a type
    // error, and the RLS WITH CHECK clause rejects it server-side regardless.
    .insert({ ...input, owner_id: userId })
    .select()
    .single();

  if (error) throw new Error(`createDeck failed: ${error.message}`);
  return data;
}

/**
 * Stores a user-supplied style reference image and records it as a deck asset.
 *
 * Uploads under `<deck_id>/...` because the deck-uploads storage policies
 * authorise on that first path segment (see migration 0600) — any other shape
 * is rejected by Postgres, not just convention.
 */
export async function uploadReferenceImage(
  userId: string,
  deckId: string,
  file: File,
): Promise<void> {
  await assertDeckOwner(userId, deckId);

  const supabase = await createClient();
  const extension = file.name.split('.').pop() ?? 'bin';
  const storagePath = `${deckId}/reference.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from('deck-uploads')
    .upload(storagePath, file, { contentType: file.type, upsert: true });
  if (uploadError) throw new Error(`uploadReferenceImage failed: ${uploadError.message}`);

  const { error: insertError } = await supabase.from('deck_assets').insert({
    deck_id: deckId,
    kind: 'upload',
    source: 'upload',
    bucket: 'deck-uploads',
    storage_path: storagePath,
  });
  if (insertError) throw new Error(`uploadReferenceImage failed: ${insertError.message}`);
}

/** Buckets a deck can have files in, all keyed by `<deck_id>/...`. */
const DECK_BUCKETS = ['deck-uploads', 'deck-assets', 'deck-exports'] as const;

/**
 * Deletes a deck, its rows, and its files.
 *
 * `on delete cascade` takes care of slides, assets, jobs, runs and exports —
 * but NOT the objects in storage, which Postgres knows nothing about. Without
 * this the reference image and every rendered .pptx would outlive the deck
 * that justified them, unreachable and still billed for.
 *
 * Storage first, deliberately. A failed file delete leaves a deck the user can
 * try again on; deleting the row first would leave orphans with no deck id to
 * find them by.
 */
export async function deleteDeck(userId: string, deckId: string): Promise<void> {
  const supabase = await createClient();

  await assertDeckOwner(userId, deckId);

  for (const bucket of DECK_BUCKETS) {
    const { data: files } = await supabase.storage.from(bucket).list(deckId);
    if (!files?.length) continue;

    const { error } = await supabase.storage
      .from(bucket)
      .remove(files.map((file) => `${deckId}/${file.name}`));

    if (error) throw new Error(`deleteDeck could not clear ${bucket}: ${error.message}`);
  }

  const { error } = await supabase.from('decks').delete().eq('id', deckId).eq('owner_id', userId);

  if (error) throw new Error(`deleteDeck failed: ${error.message}`);
}
