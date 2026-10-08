import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { estimateDeckCost, formatUsd, IMAGE_COST_USD } from '@agents/cost';

import { DeckActions } from '@/components/decks/deck-actions';
import { DraftReview } from '@/components/decks/draft-review';
import { DeckViewer } from '@/components/slides/deck-viewer';
import { requireUserId } from '@/lib/auth/session';
import { getOwnedDeck } from '@/lib/data/decks';
import { getDraft } from '@/lib/data/drafts';
import { toDeckView } from '@/lib/slides/deck-view';

/**
 * The deck viewer.
 *
 * A Server Component start to finish: it reads the deck, parses the stored
 * style spec and blocks, and hands the client only what has to be interactive
 * (which slide is showing). Nothing about the deck is fetched in the browser.
 *
 * The deck id handed to `DeckViewer` is what turns the animation editor on: it
 * is both what a save needs and the signal that this viewer is showing the
 * user's own deck rather than a link-shared one.
 *
 * `requireUserId()` runs here even though the layout already called it — a
 * layout can be skipped on a client-side navigation, so it is convenience, not
 * the boundary. `getOwnedDeck` then filters by owner on top of RLS.
 */

export async function generateMetadata({ params }: PageProps<'/app/decks/[deckId]'>) {
  const { deckId } = await params;
  const userId = await requireUserId();
  const deck = await getOwnedDeck(userId, deckId);

  return { title: deck ? `${deck.title} · Lumina` : 'Deck · Lumina' };
}

export default async function DeckPage({ params }: PageProps<'/app/decks/[deckId]'>) {
  const { deckId } = await params;
  const userId = await requireUserId();

  const deck = await getOwnedDeck(userId, deckId);
  // Not-found rather than forbidden: a deck someone else owns should not be
  // distinguishable from one that never existed.
  if (!deck) notFound();

  // The review gate. A deck waiting on its owner has an outline and no slides,
  // so the page shows the plan instead of an empty viewer.
  const draft = deck.status === 'awaiting_review' ? await getDraft(userId, deckId) : null;

  if (draft) {
    const cost = estimateDeckCost(draft.plan.slides.length);

    return (
      <div className="px-8 py-6">
        <header className="mb-5">
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            Decks
          </Link>
          <h1 className="mt-1 truncate text-xl font-bold">{deck.title}</h1>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            Outline ready — review it before the deck is built
          </p>
        </header>

        <DraftReview
          deckId={deck.id}
          title={draft.plan.title}
          objective={draft.plan.objective}
          audience={draft.plan.audience}
          slides={draft.plan.slides.map((slide) => ({
            number: slide.number,
            section: slide.section,
            purpose: slide.purpose,
            keyMessage: slide.keyMessage,
            content: slide.content,
            wordBudget: slide.wordBudget,
          }))}
          messages={draft.messages}
          cost={{
            build: formatUsd(cost.buildUsd),
            images: cost.images,
            perImage: formatUsd(IMAGE_COST_USD),
          }}
        />
      </div>
    );
  }

  const view = toDeckView(deck, deck.slides);

  return (
    <div className="px-8 py-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            Decks
          </Link>
          <h1 className="mt-1 truncate text-xl font-bold">{deck.title}</h1>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {view.slides.length} slide{view.slides.length === 1 ? '' : 's'}
            {deck.status === 'generating' ? ' · still building' : ''}
          </p>
        </div>

        <div className="shrink-0">
          <DeckActions deckId={deck.id} deckTitle={deck.title} status={deck.status} />
        </div>
      </header>

      {deck.status === 'generating' && view.slides.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This deck is still being built. Slides appear here as soon as the build finishes.
        </p>
      ) : (
        <DeckViewer view={view} deckId={deck.id} />
      )}
    </div>
  );
}
