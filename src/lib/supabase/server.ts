import 'server-only';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { publicEnv } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Request-scoped Supabase client carrying the caller's Clerk token.
 *
 * Supabase is configured with Clerk as a third-party auth provider, so it
 * verifies that token itself and exposes its `sub` claim (the Clerk user id) to
 * RLS through public.clerk_user_id(). Every policy in supabase/migrations is
 * written against that, which means this client sees exactly the rows the
 * signed-in user owns — no service-role key involved.
 *
 * Create it per request. Never hoist it to a module constant: the token is the
 * caller's, and a shared instance would hand one user's rows to another.
 */
export async function createClient() {
  const { getToken } = await auth();

  return createSupabaseClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    // Suitable for short requests. Without options, Clerk returns the JWT
    // from the original request, which can expire during long setup work.
    accessToken: async () => (await getToken()) ?? null,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Mint a fresh Clerk JWT for each DB operation after long-running work.
 * Pass only a sessionId obtained from server-side auth(), never request input.
 */
export function createClientWithFreshSessionToken(sessionId: string) {
  return createSupabaseClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    accessToken: async () => {
      const clerk = await clerkClient();
      return (await clerk.sessions.getToken(sessionId)).jwt;
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Anonymous client, for genuinely public data (link-shared decks, public bucket
 * images). Carries no identity, so RLS treats it as `anon`.
 */
export function createPublicClient() {
  return createSupabaseClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
