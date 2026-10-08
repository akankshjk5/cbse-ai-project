'use client';

import { useSession } from '@clerk/nextjs';
import { createBrowserClient } from '@supabase/ssr';
import { useMemo } from 'react';

import { publicEnv } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Browser Supabase client carrying the Clerk session token.
 *
 * Same deal as the server client: Supabase verifies the Clerk token and RLS
 * scopes the rows. That makes Realtime subscriptions on owned data work from
 * the browser — which is how the generation progress UI is meant to be built.
 *
 * Do not call supabase.auth.* — Clerk owns the session. Sign-in and sign-out
 * come from @clerk/nextjs.
 */
export function useSupabase() {
  const { session } = useSession();

  return useMemo(
    () =>
      createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
        accessToken: async () => (await session?.getToken()) ?? null,
      }),
    [session],
  );
}

/**
 * Anonymous browser client for public pages (the shared-deck viewer), where
 * there may be no Clerk session at all.
 */
export function createPublicClient() {
  return createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}
