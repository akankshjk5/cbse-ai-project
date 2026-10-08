import 'server-only';

import { createClient } from '@/lib/supabase/server';
import type { Profile } from '@/lib/supabase/types';

/**
 * Profiles hold only what Clerk does not: generation preferences and app state.
 * Names, emails and avatars stay at Clerk — read those from currentUser().
 */

/**
 * Returns the caller's profile, creating it on first sight.
 *
 * **Reads before it writes**, and that is the whole point of the shape. This
 * runs at the top of the signed-in shell — every visit to /app, by every user —
 * and it used to be an unconditional `upsert`. An upsert is a write: it takes a
 * row lock, produces WAL, replicates, and fires the `updated_at` trigger, once
 * per page view forever, to store a row that changed on exactly one of those
 * page views. At a million users that is a million writes a day to keep a
 * million unchanged rows unchanged.
 *
 * The read is an indexed primary-key lookup and is essentially free. The insert
 * happens once per account in the ordinary case, and not at all when Clerk's
 * `user.created` webhook (src/app/api/webhooks/clerk) got there first.
 *
 * The webhook does not replace this. Webhooks are eventually consistent and
 * occasionally lost, and "your account exists" is not something to make a new
 * user wait on a retry schedule for — so this stays the thing the app depends
 * on, and the webhook is the optimisation.
 */
export async function ensureProfile(userId: string): Promise<Profile> {
  const existing = await getProfile(userId);
  if (existing) return existing;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id: userId })
    .select()
    .single();

  if (data) return data;

  // 23505: the webhook (or a second tab) inserted the row between the read and
  // this insert. That is the race working correctly, not a failure — read back
  // what the winner wrote.
  if (error?.code === '23505') {
    const raced = await getProfile(userId);
    if (raced) return raced;
  }

  throw new Error(`ensureProfile failed: ${error?.message ?? 'profile missing after insert'}`);
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(`getProfile failed: ${error.message}`);
  return data;
}
