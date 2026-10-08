'use server';

import { requireUserId } from '@/lib/auth/session';
import { failJob, latestJob, listAgentRuns } from '@/lib/data/generation';

export type JobSnapshot = {
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
} | null;

/**
 * The current state of a deck's newest build.
 *
 * The card watches Realtime first, but Realtime is a socket: it can fail to
 * connect, be dropped by a proxy, or miss the one update that mattered. A deck
 * that finished — and especially one that FAILED — must not sit on "Generating"
 * because a websocket did not arrive. This is the poll the card falls back to.
 */
/**
 * How long a job may go without a progress tick before it is presumed dead.
 *
 * The build runs in `after()`, which does not survive the process. A dev-server
 * restart, a deploy, or a crash mid-build leaves the row on `running` with
 * nobody left to finish it or mark it failed — and the card would spin forever.
 * Stages are minutes apart at worst, so ten is a wide margin.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

export async function getJobStatusAction(deckId: string): Promise<JobSnapshot> {
  const userId = await requireUserId();

  // RLS scopes the read; a deck the caller does not own simply has no job.
  const job = await latestJob(userId, deckId);
  if (!job) return null;

  const idleFor = Date.now() - new Date(job.updated_at).getTime();

  if (job.status === 'running' && idleFor > STALE_AFTER_MS) {
    const message =
      'The build stopped without finishing — the server most likely restarted. Try again.';

    // Recorded, not just reported: leaving the row on `running` would leave the
    // deck on `generating`, so the next page load would spin all over again.
    // `latestJob` is RLS-scoped, so reaching here proves the caller owns it.
    await failJob(job.id, deckId, message).catch(() => {});

    return { status: 'failed', stage: job.stage, progress: Number(job.progress), error: message };
  }

  return {
    status: job.status,
    stage: job.stage,
    progress: Number(job.progress),
    error: job.error,
  };
}

export type AgentRunRow = Awaited<ReturnType<typeof listAgentRuns>>[number];

/**
 * The per-agent log for a deck's most recent build.
 *
 * Every model call the pipeline made, in order, with what it cost. RLS scopes
 * the read to decks the caller owns.
 */
export async function getAgentRunsAction(deckId: string): Promise<AgentRunRow[]> {
  const userId = await requireUserId();

  try {
    return await listAgentRuns(userId, deckId);
  } catch {
    return [];
  }
}
