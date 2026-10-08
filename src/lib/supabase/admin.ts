import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { publicEnv, serverEnv } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Service-role client. BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * Use it only where RLS cannot express the need and the caller has already been
 * authorised in code:
 *   - the generation worker writing generation_jobs / agent_runs
 *   - the ingest worker writing document_chunks
 *   - uploading generated images to storage on the user's behalf
 *
 * Every such call site must first establish who the user is (getUser()) and
 * check they own the deck_id it is about to touch. If you find yourself
 * reaching for this to "make a query work", the real fix is an RLS policy.
 *
 * Never import this file from anything that can reach a Client Component.
 */
let cached: ReturnType<typeof createSupabaseClient<Database>> | null = null;

export function createAdminClient() {
  cached ??= createSupabaseClient<Database>(
    publicEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  return cached;
}
