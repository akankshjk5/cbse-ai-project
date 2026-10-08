import 'server-only';

import { auth, currentUser } from '@clerk/nextjs/server';

/**
 * Clerk owns identity. `userId` here is a Clerk id — a string like
 * `user_2abc...`, NOT a uuid. It is what every `owner_id` column stores.
 */

/** The signed-in user's Clerk id, or null. */
export async function getCurrentUserId() {
  const { userId } = await auth();
  return userId;
}

/**
 * The signed-in user's Clerk id, or a redirect to sign-in.
 *
 * Every data-touching page, Server Action and Route Handler starts with this.
 * The proxy gate is the outer door; this is the lock on the room.
 */
export async function requireUserId() {
  const { userId, redirectToSignIn } = await auth();
  if (!userId) redirectToSignIn();
  return userId as string;
}

/** Route-handler flavour: 401 instead of a redirect. */
export async function requireUserIdOrThrow() {
  const { userId } = await auth();
  if (!userId) throw new Response('Unauthorized', { status: 401 });
  return userId;
}

/** Full Clerk user record (email, name, image). Hits Clerk's API — use sparingly. */
export async function getCurrentUser() {
  return currentUser();
}
