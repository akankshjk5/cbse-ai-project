import { Presentation } from 'lucide-react';
import Link from 'next/link';

import { DeckActions } from './deck-actions';
import { DeckActivity } from './deck-activity';
import { DeckProgress } from './deck-progress';
import { SlideCanvas } from '@/components/slides/slide-canvas';
import { toDeckView } from '@/lib/slides/deck-view';
import type { Deck, DeckStatus, GenerationJob, Slide } from '@/lib/supabase/types';

/** Status pill colours. `draft` gets none — an unbuilt deck is unremarkable. */
const STATUS_STYLES: Partial<Record<DeckStatus, { label: string; className: string }>> = {
  awaiting_review: {
    label: 'Review outline',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  },
  generating: {
    label: 'Generating',
    className: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  },
  ready: {
    label: 'Ready',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  },
};

/** "2 days ago" — coarse on purpose; deck lists never need minute precision. */
function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secondsPerUnit] of units) {
    if (Math.abs(seconds) >= secondsPerUnit) {
      return formatter.format(-Math.round(seconds / secondsPerUnit), unit);
    }
  }
  return 'just now';
}

export function DeckCard({
  deck,
  job = null,
  cover = null,
}: {
  deck: Deck;
  /** Newest generation job, so a card renders mid-build without waiting for Realtime. */
  job?: Pick<GenerationJob, 'status' | 'stage' | 'progress' | 'error'> | null;
  /** The deck's first slide, drawn as the thumbnail. */
  cover?: Slide | null;
}) {
  const badge = STATUS_STYLES[deck.status];
  // The same renderer as the viewer and the same theme as the .pptx, at 240px.
  // A thumbnail that is a real slide is worth far more than a generic icon —
  // it is how you find the deck you meant among twenty.
  const preview = cover ? toDeckView(deck, [cover]) : null;

  return (
    <article className="group overflow-hidden rounded-xl border border-black/10 bg-white transition-shadow hover:shadow-md dark:border-white/10 dark:bg-neutral-900">
      <Link href={`/app/decks/${deck.id}`} className="block" aria-label={`Open ${deck.title}`}>
        {preview?.slides[0] ? (
          <SlideCanvas
            slide={preview.slides[0]}
            theme={preview.theme}
            slideSize={preview.slideSize}
          />
        ) : (
          <div className="flex h-[135px] items-center justify-center bg-neutral-100 dark:bg-neutral-800">
            <Presentation
              className="h-8 w-8 text-neutral-300 dark:text-neutral-600"
              strokeWidth={1.5}
            />
          </div>
        )}
      </Link>
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 min-h-[2.75rem] text-[15px] font-semibold leading-snug">
            <Link href={`/app/decks/${deck.id}`} className="hover:underline">
              {deck.title}
            </Link>
          </h3>
          {badge ? (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
            >
              {badge.label}
            </span>
          ) : null}
        </div>

        {deck.status === 'awaiting_review' ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            The outline is ready. Nothing has been built yet — open it to review
            and approve.
          </p>
        ) : (
          <DeckProgress deckId={deck.id} deckStatus={deck.status} initialJob={job} />
        )}
        <DeckActions deckId={deck.id} deckTitle={deck.title} status={deck.status} />
        <DeckActivity deckId={deck.id} status={deck.status} />

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Viewed {relativeTime(deck.updated_at)}
          </span>
        </div>
      </div>
    </article>
  );
}
