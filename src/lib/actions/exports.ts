'use server';

import { requireUserId } from '@/lib/auth/session';
import { latestExportUrl } from '@/lib/data/generation';

/**
 * Hands back a short-lived signed URL for a deck's newest .pptx.
 *
 * Minted on demand rather than stored on the deck row: `deck-exports` is a
 * private bucket, and a URL baked into the page at render time would still be
 * live in someone's browser history long after the page was closed. Ten
 * minutes is enough to click a download button.
 */
export async function getDeckDownloadUrlAction(
  deckId: string,
): Promise<{ url: string | null; error: string | null }> {
  const userId = await requireUserId();

  try {
    // latestExportUrl runs on the user-scoped client, so RLS — not this
    // function — is what refuses a deck the caller does not own.
    return { url: await latestExportUrl(userId, deckId), error: null };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
}
