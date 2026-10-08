'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { getJobStatusAction } from '@/lib/actions/generation';
import { ceilingForStage, labelForStage, progressForStage } from '@/lib/generation/stages';
import { useSupabase } from '@/lib/supabase/client';
import type { DeckStatus, GenerationJob } from '@/lib/supabase/types';

/**
 * Live build progress for one deck card.
 *
 * Three things keep it honest:
 *
 * 1. **Realtime** on that deck's `generation_jobs` row. The Clerk token is on
 *    the socket and the table's RLS policy is `owner_id = clerk_user_id()`, so
 *    a subscription can only deliver the user's own jobs — the filter is for
 *    traffic, not security.
 * 2. **A poll**, because a socket can fail to connect or miss the one update
 *    that mattered, and a finished or failed build must never sit on
 *    "Generating" forever.
 * 3. **A creep**, because stages are minutes apart. Without it the bar holds
 *    one value long enough to look broken. It advances towards — never past —
 *    the next stage's mark, so it never promises progress that has not
 *    happened.
 */

const POLL_MS = 4000;
const CREEP_MS = 400;

type JobShape = Pick<GenerationJob, 'status' | 'stage' | 'progress' | 'error'>;

export function DeckProgress({
  deckId,
  deckStatus,
  initialJob,
}: {
  deckId: string;
  deckStatus: DeckStatus;
  initialJob: JobShape | null;
}) {
  const supabase = useSupabase();
  const router = useRouter();
  const [job, setJob] = useState<JobShape | null>(initialJob);

  /**
   * The number actually on screen, as a fraction.
   *
   * Held separately from the job's own `progress` because the creep moves it
   * between updates. It only ever increases: a revision pass reports a lower
   * stage, and a bar that slides backwards reads as something going wrong.
   */
  const [displayed, setDisplayed] = useState(() => Number(initialJob?.progress ?? 0));

  const settled = job?.status === 'succeeded' || job?.status === 'failed';

  /** Applies a job update, pulling the bar forward if the server is ahead. */
  const applyJob = useCallback(
    (next: JobShape) => {
      setJob(next);
      setDisplayed((current) => Math.max(current, Number(next.progress ?? 0)));

      if (next.status === 'succeeded' || next.status === 'failed') router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (deckStatus !== 'generating') return;

    const channel = supabase
      .channel(`deck-job:${deckId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'generation_jobs',
          filter: `deck_id=eq.${deckId}`,
        },
        (payload) => applyJob(payload.new as JobShape),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, deckId, deckStatus, applyJob]);

  useEffect(() => {
    if (deckStatus !== 'generating' || settled) return;

    let cancelled = false;

    async function check() {
      const snapshot = await getJobStatusAction(deckId).catch(() => null);
      if (!cancelled && snapshot) applyJob(snapshot as JobShape);
    }

    // Once immediately: a card rendered from a stale server snapshot should not
    // wait a whole interval to catch up.
    void check();

    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [deckId, deckStatus, settled, applyJob]);

  useEffect(() => {
    if (deckStatus !== 'generating' || settled) return;

    const ceiling = ceilingForStage(job?.stage ?? 'queued');

    const timer = setInterval(() => {
      setDisplayed((current) => {
        if (current >= ceiling) return current;
        // Ease towards the ceiling: obvious movement early in a stage, barely
        // perceptible as it approaches, so a long stage never appears stuck
        // and never appears finished.
        return Math.min(ceiling, current + (ceiling - current) * 0.04 + 0.0015);
      });
    }, CREEP_MS);

    return () => clearInterval(timer);
  }, [deckStatus, settled, job?.stage]);

  if (deckStatus === 'failed' || job?.status === 'failed') {
    return (
      <p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-400">
        {job?.error ?? 'Generation failed.'}
      </p>
    );
  }

  if (deckStatus !== 'generating') return null;

  const stage = job?.stage ?? 'queued';
  // A succeeded job whose page has not refreshed yet should read as done.
  const fraction = job?.status === 'succeeded' ? 1 : Math.max(displayed, progressForStage(stage));
  const percent = Math.round(fraction * 100);

  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={labelForStage(stage)}
        className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
      >
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
      <p className="mt-1.5 flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="truncate">{labelForStage(stage)}…</span>
        <span className="shrink-0 tabular-nums">{percent}%</span>
      </p>
    </div>
  );
}
