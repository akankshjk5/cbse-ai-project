import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Account lifecycle: provisioning and erasure.
 *
 * Both run on the **service-role** client, which is the one place in the app
 * where that is not a shortcut. These are called from Clerk's webhook, which
 * arrives with no session at all — there is no Clerk token to scope a client
 * with, and `public.clerk_user_id()` would resolve to null, so every RLS
 * policy would refuse. This is the background-worker case the admin client
 * exists for.
 *
 * Everything here is **idempotent**. Svix retries a webhook that does not
 * answer 2xx, on a schedule, for a day — so a purge that half-succeeded will
 * be run again, and a second `user.created` for a user that already exists is
 * routine rather than exceptional.
 */

/** Buckets whose objects are keyed by deck id. Mirrors `DECK_BUCKETS` in decks.ts. */
const DECK_BUCKETS = ['deck-uploads', 'deck-assets', 'deck-exports'] as const;

/**
 * Creates the profile row for a new Clerk user.
 *
 * Only generation preferences live here. Name, email and avatar stay at Clerk
 * and are read from `currentUser()` — a mirrored copy goes stale the first
 * time someone changes their email somewhere else, silently, and then the app
 * is confidently wrong about who its user is.
 */
export async function provisionAccount(userId: string): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin
    .from('profiles')
    .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

  if (error) throw new Error(`provisionAccount failed: ${error.message}`);
}

/**
 * Erases everything an account owns.
 *
 * Called on Clerk's `user.deleted`. Without it a deleted user's decks,
 * research, generated art and rendered .pptx files live in Postgres and in
 * three storage buckets forever: unreachable, un-deletable through the UI
 * (there is no session to delete them with any more) and still billed for.
 * That is a data-protection problem before it is a cost one — "delete my
 * account" has to mean it.
 *
 * Order matters and is the same as `deleteDeck`'s, for the same reason:
 * storage objects are found BY deck id, so the rows have to outlive the files.
 * A failed file delete leaves rows the retry can find again; deleting the rows
 * first would strand the files with nothing left pointing at them.
 *
 * Deleting `decks` cascades to slides, deck_assets, generation_jobs,
 * agent_runs, deck_drafts, deck_exports and any document chunks hanging off
 * them — every one of those tables declares `on delete cascade` against the
 * deck. What does not hang off a deck is deleted explicitly below.
 */
export async function purgeAccount(userId: string): Promise<{ decks: number }> {
  const admin = createAdminClient();

  const { data: decks, error: listError } = await admin
    .from('decks')
    .select('id')
    .eq('owner_id', userId);

  if (listError) throw new Error(`purgeAccount could not list decks: ${listError.message}`);

  const deckIds = (decks ?? []).map((deck) => deck.id);

  for (const deckId of deckIds) {
    for (const bucket of DECK_BUCKETS) {
      const { data: files } = await admin.storage.from(bucket).list(deckId);
      if (!files?.length) continue;

      const { error } = await admin.storage
        .from(bucket)
        .remove(files.map((file) => `${deckId}/${file.name}`));

      // Loud, but not fatal: one bucket refusing a delete must not leave the
      // other two — and the rows — behind. The throw at the end of the
      // function is what tells Svix to retry.
      if (error) {
        console.error(`[account] ${userId}: could not clear ${bucket}/${deckId}: ${error.message}`);
      }
    }
  }

  // Everything keyed by owner rather than by deck. `deck_imports` survives its
  // deck (`on delete set null`), and `documents` may never have had one.
  for (const table of ['decks', 'documents', 'deck_imports'] as const) {
    const { error } = await admin.from(table).delete().eq('owner_id', userId);
    if (error) throw new Error(`purgeAccount could not clear ${table}: ${error.message}`);
  }

  const { error: profileError } = await admin.from('profiles').delete().eq('id', userId);
  if (profileError) {
    throw new Error(`purgeAccount could not delete the profile: ${profileError.message}`);
  }

  return { decks: deckIds.length };
}
