import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';

import { provisionAccount, purgeAccount } from '@/lib/data/accounts';

/**
 * Clerk's account lifecycle, applied to our own database.
 *
 * Two events matter here, and they are the two halves of the same fact — that
 * Clerk owns identity and Postgres only ever holds rows *about* an identity:
 *
 *  - `user.created` provisions the profile row. It is a convenience, not the
 *    boundary: webhooks are eventually consistent, so `ensureProfile` still
 *    runs on first sight of a signed-in user and remains the thing the app
 *    actually depends on. Doing it here as well means the row usually exists
 *    before the user's first page view rather than because of it.
 *  - `user.deleted` erases everything they own. This one has no backstop and
 *    cannot have one: once the Clerk user is gone there is no session left to
 *    delete their decks with, and nothing else in the system will ever notice
 *    those rows again. Without this handler "delete my account" leaves the
 *    account's research, decks and generated art in three storage buckets
 *    indefinitely.
 *
 * Verification is not optional. `verifyWebhook` checks the Svix signature
 * against `CLERK_WEBHOOK_SIGNING_SECRET`; without it this is an unauthenticated
 * endpoint that deletes any account whose id is posted to it.
 *
 * The route is public in `src/proxy.ts` — Clerk calls it with no session, so
 * `auth.protect()` would answer 401 to Clerk itself.
 */

export async function POST(request: NextRequest) {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch (error) {
    // 400, never 500: a bad signature is a rejected request, and answering 5xx
    // would make Svix retry a forgery for a day.
    console.error('[clerk webhook] verification failed:', error);
    return new Response('Verification failed', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'user.created':
        await provisionAccount(event.data.id);
        break;

      case 'user.deleted': {
        // `id` is optional on a deletion payload — Clerk sends `deleted: true`
        // events for objects it can no longer identify. Nothing to purge, and
        // guessing would be catastrophic here of all places.
        const userId = event.data.id;
        if (!userId) break;

        const { decks } = await purgeAccount(userId);
        console.log(`[clerk webhook] purged ${userId}: ${decks} deck(s)`);
        break;
      }

      default:
        // Everything else is acknowledged and ignored. Answering 2xx stops
        // Svix retrying events this app has no opinion about.
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clerk webhook] ${event.type} failed: ${message}`);
    // 500 so Svix retries. Both handlers are idempotent, which is what makes
    // that safe rather than merely hopeful.
    return new Response('Handler failed', { status: 500 });
  }

  return new Response('OK', { status: 200 });
}
