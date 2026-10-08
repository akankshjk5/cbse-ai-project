import { ChevronLeft, ChevronRight, Presentation } from 'lucide-react';
import Link from 'next/link';

import { CreateDeckDialog } from '@/components/decks/create-deck-dialog';
import { ProductSwitcher } from '@/components/app-shell/product-switcher';
import { DeckCard } from '@/components/decks/deck-card';
import { requireUserId } from '@/lib/auth/session';
import { DECK_PAGE_SIZE, coverSlides, listDecks } from '@/lib/data/decks';
import { latestJobsByDeck } from '@/lib/data/generation';
import { ensureProfile } from '@/lib/data/profiles';
import type { Deck, GenerationJob, Slide } from '@/lib/supabase/types';

export const metadata = { title: 'Your decks · Lumina' };

/**
 * The deck list.
 *
 * Paged, because an account is allowed 200 decks (`ACCOUNT_LIMITS`) and a grid
 * that renders all of them also renders 200 `SlideCanvas` thumbnails. The page
 * number lives in the URL rather than in client state, so a card the user
 * navigated to and came back from lands them where they were.
 */
export default async function AppPage({ searchParams }: PageProps<'/app'>) {
  const userId = await requireUserId();

  const params = await searchParams;
  const requested = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(requested) && requested > 1 ? requested : 1;

  // The data layer can still fail while the Clerk/Supabase handshake is being
  // configured. Render the shell with an inline error rather than a 500 — a
  // blank 500 hides which of the two sides is misconfigured.
  let decks: Deck[] = [];
  let total = 0;
  let jobs = new Map<string, GenerationJob>();
  let covers = new Map<string, Slide>();
  let dataError: string | null = null;

  try {
    await ensureProfile(userId);

    const listed = await listDecks(userId, { offset: (page - 1) * DECK_PAGE_SIZE });
    decks = listed.decks;
    total = listed.total;

    const deckIds = decks.map((deck) => deck.id);
    jobs = await latestJobsByDeck(userId, deckIds);
    covers = await coverSlides(deckIds);
  } catch (error) {
    dataError = error instanceof Error ? error.message : String(error);
  }

  const pages = Math.max(1, Math.ceil(total / DECK_PAGE_SIZE));

  return (
    <div className="px-8 py-6">
      <ProductSwitcher />
      <header className="mt-6 flex items-center justify-between gap-4">
        <h1 className="flex items-center gap-2.5 text-xl font-bold">
          <Presentation className="h-5 w-5" strokeWidth={2} />
          Decks
          {total > 0 ? (
            <span className="text-sm font-normal tabular-nums text-neutral-500 dark:text-neutral-400">
              {total}
            </span>
          ) : null}
        </h1>
        <CreateDeckDialog />
      </header>

      {dataError ? (
        <div className="mt-6 rounded-xl border border-amber-400/50 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-semibold">Deck list unavailable</p>
          <p className="mt-1 font-mono text-xs">{dataError}</p>
        </div>
      ) : null}

      {decks.length > 0 ? (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5">
          {decks.map((deck) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              job={jobs.get(deck.id) ?? null}
              cover={covers.get(deck.id) ?? null}
            />
          ))}
        </div>
      ) : null}

      {pages > 1 ? (
        <nav
          aria-label="Deck pages"
          className="mt-8 flex items-center justify-center gap-2 text-sm"
        >
          <PageLink page={page - 1} disabled={page === 1} label="Previous">
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </PageLink>

          <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
            {page} / {pages}
          </span>

          <PageLink page={page + 1} disabled={page === pages} label="Next">
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </PageLink>
        </nav>
      ) : null}

      {!dataError && decks.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
          {page > 1 ? 'Nothing on this page.' : 'No decks yet.'}
        </p>
      ) : null}
    </div>
  );
}

/** A pager arrow. Disabled renders as a span — a link to nowhere is not a control. */
function PageLink({
  page,
  disabled,
  label,
  children,
}: {
  page: number;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const shape = 'rounded-lg border border-black/10 p-1.5 dark:border-white/10';

  if (disabled) {
    return (
      <span aria-hidden className={`${shape} opacity-40`}>
        {children}
      </span>
    );
  }

  return (
    <Link
      href={page <= 1 ? '/app' : `/app?page=${page}`}
      aria-label={label}
      className={`${shape} transition-colors hover:bg-black/5 dark:hover:bg-white/10`}
    >
      {children}
    </Link>
  );
}
