'use client';

import { Check, Loader2, MessageSquare, Send } from 'lucide-react';
import { useState, useTransition } from 'react';

import { approveDraftAction, reviseDraftAction } from '@/lib/actions/drafts';
import type { DraftMessage } from '@/lib/data/drafts';

/**
 * The review gate.
 *
 * Everything the deck will say, before any of it is paid for. Research and an
 * outline cost about a cent; style, writing and illustration cost twenty to
 * thirty times that, nearly all of it pictures. So the build stops here and
 * shows its work: what each slide will cover, how long it will be, and what
 * pressing Build will actually cost.
 *
 * The chat is not a general assistant — it edits this outline and nothing
 * else. Each turn is one call to the same planner that wrote the plan, handed
 * the plan and the research it came from, so a revision cannot answer "add a
 * slide on cost" by inventing a figure that was never found.
 */

export interface DraftSlide {
  number: number;
  section: 'intro' | 'body' | 'conclusion';
  purpose: string;
  keyMessage: string;
  content: string[];
  wordBudget: number;
}

export interface DraftReviewProps {
  deckId: string;
  title: string;
  objective: string;
  audience?: string;
  slides: DraftSlide[];
  messages: DraftMessage[];
  /** Formatted by the server from measured per-call costs. */
  cost: { build: string; images: number; perImage: string };
}

const SECTION_STYLES: Record<DraftSlide['section'], string> = {
  intro: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  body: 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
  conclusion: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
};

export function DraftReview({
  deckId,
  title,
  objective,
  audience,
  slides,
  messages,
  cost,
}: DraftReviewProps) {
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revising, startRevision] = useTransition();
  const [approving, startApproval] = useTransition();

  const busy = revising || approving;

  function revise() {
    const text = instruction.trim();
    if (!text || busy) return;

    setError(null);
    startRevision(async () => {
      const result = await reviseDraftAction(deckId, text);
      if (result.error) setError(result.error);
      // Cleared only on success, so a failed request does not also lose what
      // the user typed.
      else setInstruction('');
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* ── The outline ─────────────────────────────────────────────────── */}
      <section className="min-w-0">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{objective}</p>
          {audience ? (
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              For {audience}
            </p>
          ) : null}
        </header>

        <ol className="space-y-3">
          {slides.map((slide) => (
            <li
              key={slide.number}
              className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs tabular-nums text-neutral-400">{slide.number}</span>
                <h3 className="flex-1 text-sm font-semibold leading-snug">{slide.keyMessage}</h3>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    SECTION_STYLES[slide.section]
                  }`}
                >
                  {slide.section}
                </span>
              </div>

              <p className="mt-1 pl-6 text-xs text-neutral-500 dark:text-neutral-400">
                {slide.purpose} · up to {slide.wordBudget} words
              </p>

              {slide.content.length > 0 ? (
                <ul className="mt-2 space-y-1 pl-6">
                  {slide.content.map((point, index) => (
                    <li
                      key={index}
                      className="flex gap-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
                    >
                      <span aria-hidden className="text-neutral-300 dark:text-neutral-600">
                        —
                      </span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* ── Cost, approval, and the conversation ────────────────────────── */}
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
          <h3 className="text-sm font-semibold">Ready to build</h3>

          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-neutral-500 dark:text-neutral-400">Slides</dt>
              <dd className="tabular-nums">{slides.length}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-neutral-500 dark:text-neutral-400">
                Images ({cost.perImage} each)
              </dt>
              <dd className="tabular-nums">{cost.images}</dd>
            </div>
            <div className="flex justify-between gap-2 border-t border-black/5 pt-1.5 font-medium dark:border-white/10">
              <dt>Estimated cost</dt>
              <dd className="tabular-nums">{cost.build}</dd>
            </div>
          </dl>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              startApproval(async () => {
                const result = await approveDraftAction(deckId);
                if (result.error) setError(result.error);
              });
            }}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
          >
            {approving ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <Check className="h-4 w-4" strokeWidth={2} />
            )}
            {approving ? 'Starting…' : 'Build this deck'}
          </button>

          <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            Nothing has been generated yet beyond this outline. Building writes
            every slide and draws {cost.images} pictures.
          </p>
        </div>

        <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={2} />
            Change something
          </h3>

          {messages.length > 0 ? (
            <ol className="mt-3 max-h-64 space-y-2 overflow-y-auto">
              {messages.map((message, index) => (
                <li
                  key={index}
                  className={`rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
                    message.role === 'user'
                      ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-100'
                      : 'bg-neutral-50 text-neutral-700 dark:bg-white/5 dark:text-neutral-300'
                  }`}
                >
                  {message.content}
                </li>
              ))}
            </ol>
          ) : null}

          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline. A revision is a
              // sentence, so sending is much the commoner intent.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                revise();
              }
            }}
            disabled={busy}
            rows={3}
            placeholder="Add a slide on real-world uses. Drop slide 4. Make it simpler."
            className="mt-3 w-full resize-none rounded-lg border border-black/10 bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none placeholder:text-neutral-400 focus:border-indigo-400 disabled:opacity-60 dark:border-white/10"
          />

          <button
            type="button"
            disabled={busy || !instruction.trim()}
            onClick={revise}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
          >
            {revising ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Send className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            {revising ? 'Revising…' : 'Revise the outline'}
          </button>
        </div>

        {error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
