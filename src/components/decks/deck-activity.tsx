'use client';

import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { getAgentRunsAction, type AgentRunRow } from '@/lib/actions/generation';
import type { DeckStatus } from '@/lib/supabase/types';

/**
 * What the agents actually did, per deck.
 *
 * Every model call the pipeline makes is already recorded in `agent_runs` —
 * agent, model, tokens, cost, latency, and the error if it failed. This is the
 * only place a user can read it. A failed build in particular is unhelpful
 * without it: "Generation failed" says nothing about which of eight specialists
 * gave up, on which model, after how long.
 *
 * While a build is running the list refreshes, so it reads as a live log
 * rather than a post-mortem.
 */

const POLL_MS = 4000;

function formatCost(runs: AgentRunRow[]): string {
  const total = runs.reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0);
  // Providers do not always report cost; a total of zero means "not reported"
  // as often as it means free, so it is not worth showing.
  return total > 0 ? `$${total.toFixed(4)}` : '';
}

function formatTokens(runs: AgentRunRow[]): string {
  const total = runs.reduce(
    (sum, run) => sum + (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0),
    0,
  );
  return total > 0 ? `${total.toLocaleString()} tokens` : '';
}

export function DeckActivity({ deckId, status }: { deckId: string; status: DeckStatus }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<AgentRunRow[] | null>(null);

  const load = useCallback(async () => {
    setRuns(await getAgentRunsAction(deckId));
  }, [deckId]);

  // The first load happens on the click that opens the panel; this effect only
  // keeps it fresh, and only while there is more to come.
  useEffect(() => {
    if (!open || status !== 'generating') return;

    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, status, load]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  // A deck that was never built has nothing to show.
  if (status === 'draft') return null;

  return (
    <div className="mt-2 border-t border-black/5 pt-2 dark:border-white/5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Agent activity
        {runs?.length ? <span className="text-neutral-400">({runs.length})</span> : null}
      </button>

      {open ? (
        <div className="mt-2">
          {runs === null ? (
            <p className="flex items-center gap-1.5 text-xs text-neutral-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-neutral-400">No agent runs recorded yet.</p>
          ) : (
            <>
              <ol className="flex flex-col gap-1.5">
                {runs.map((run, index) => (
                  <li key={`${run.agent}-${run.attempt}-${index}`} className="text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">
                        <span
                          className={
                            run.status === 'failed'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {run.status === 'failed' ? '✗' : '✓'}
                        </span>{' '}
                        {run.agent}
                        {run.attempt > 0 ? (
                          <span className="text-neutral-400"> · retry {run.attempt}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-neutral-400">
                        {run.latency_ms ? `${(run.latency_ms / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <div className="truncate pl-3.5 text-neutral-400">
                      {[
                        run.model,
                        (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0) || null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    {run.error ? (
                      <p className="line-clamp-2 pl-3.5 text-red-600 dark:text-red-400">
                        {run.error}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>

              <p className="mt-2 flex gap-2 border-t border-black/5 pt-1.5 text-xs text-neutral-400 dark:border-white/5">
                <span>{formatTokens(runs)}</span>
                <span>{formatCost(runs)}</span>
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
