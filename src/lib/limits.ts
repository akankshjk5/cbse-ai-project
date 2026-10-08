import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * Per-account limits.
 *
 * Every other guard in this app protects data. These protect **money**, and
 * they are the difference between an app that can be opened to the public and
 * one that cannot: a build spends real OpenRouter credit — roughly a cent for
 * the outline and about twenty-five times that for the finished deck, almost
 * all of it illustration — and until now nothing stopped one signed-up account
 * from starting builds in a loop. A single script could run up a four-figure
 * bill overnight, and the first anyone would know of it is the invoice.
 *
 * Three limits, because there are three distinct failure shapes:
 *
 *  - **Concurrency** bounds what one account can occupy at once. A build holds
 *    a server process for minutes (see the note on `after()` in CLAUDE.md), so
 *    this is capacity as much as cost.
 *  - **A daily rate** bounds sustained spend. It resets on a rolling 24 hours
 *    rather than at midnight, so it cannot be reset by waiting for a clock.
 *  - **A total** bounds storage: every deck keeps its slides, its generated art
 *    and its .pptx in three buckets for as long as it exists. This one gates
 *    creating a deck only — see `checkDeckQuota`.
 *
 * The numbers are deliberately generous for a real user and cheap for an
 * attacker: a teacher building a week of lessons never sees them; a loop hits
 * the first one in seconds. They are constants rather than env vars because a
 * limit that can be raised by an environment variable gets raised in an
 * incident and never lowered again — when these need to differ per account,
 * the honest answer is a plan on the profile, not a redeploy.
 */
export const ACCOUNT_LIMITS = {
  /** Builds an account may have in flight at once. */
  activeBuilds: 2,
  /** Builds an account may start in any rolling 24 hours. */
  buildsPerDay: 25,
  /** Decks an account may keep. */
  decks: 200,
} as const;

/** Job states that are still spending. Mirrors the `run_status` enum. */
const LIVE_STATUSES = ['queued', 'running'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown by `assertQuota`. Its message is written to be shown to the user. */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

/**
 * Why this account may not start another build right now, or null.
 *
 * Counts run on the **user-scoped** client, so RLS scopes them to the caller
 * even though every query also filters by owner — the same belt-and-braces
 * rule the rest of `src/lib/data` follows. All three are `head: true` count
 * queries against existing indexes (`decks_owner_updated_idx`,
 * `generation_jobs_owner_idx`), so this costs three index scans and returns no
 * rows.
 */
export async function checkBuildQuota(userId: string): Promise<string | null> {
  const supabase = await createClient();

  const [active, recent] = await Promise.all([
    supabase
      .from('generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .in('status', LIVE_STATUSES),
    supabase
      .from('generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .gte('created_at', new Date(Date.now() - DAY_MS).toISOString()),
  ]);

  for (const result of [active, recent]) {
    // A failed count must not become a free pass. Refusing here costs a user
    // one build; passing would let a database blip disable the spend limit.
    if (result.error) throw new Error(`checkBuildQuota failed: ${result.error.message}`);
  }

  if ((active.count ?? 0) >= ACCOUNT_LIMITS.activeBuilds) {
    return `You already have ${ACCOUNT_LIMITS.activeBuilds} decks building. Wait for one to finish.`;
  }

  if ((recent.count ?? 0) >= ACCOUNT_LIMITS.buildsPerDay) {
    return `You have started ${ACCOUNT_LIMITS.buildsPerDay} builds in the last 24 hours, which is the daily limit.`;
  }

  return null;
}

/**
 * Why this account may not create another deck, or null.
 *
 * Kept apart from `checkBuildQuota` on purpose. The deck ceiling is about
 * storage, and it must not apply to a build of a deck that already exists — an
 * account sitting at the limit still has to be able to approve the outline it
 * is looking at, or its last deck is permanently stuck at `awaiting_review`
 * with no way forward except deleting something else.
 */
export async function checkDeckQuota(userId: string): Promise<string | null> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .from('decks')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId);

  if (error) throw new Error(`checkDeckQuota failed: ${error.message}`);

  return (count ?? 0) >= ACCOUNT_LIMITS.decks
    ? `You have reached ${ACCOUNT_LIMITS.decks} decks. Delete one to make room.`
    : null;
}

/**
 * The same check, as a throw.
 *
 * `startJob` calls this so that a build cannot be started by any path that
 * forgot to ask — the actions check first, to put the message on the form
 * rather than in an error string, and this is what makes that a courtesy
 * rather than the control.
 */
export async function assertBuildQuota(userId: string): Promise<void> {
  const reason = await checkBuildQuota(userId);
  if (reason) throw new QuotaError(reason);
}
