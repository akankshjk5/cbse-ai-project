'use client';

import { Download, RotateCw, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';

import { deleteDeckAction, regenerateDeckAction } from '@/lib/actions/decks';
import { getDeckDownloadUrlAction } from '@/lib/actions/exports';
import type { DeckStatus } from '@/lib/supabase/types';

/**
 * Per-card controls: download, regenerate, delete.
 *
 * Delete is offered in every state, including `generating` — a build that is
 * stuck or wrong is exactly the one a user wants gone, and hiding the control
 * until it finishes would strand them.
 */

const buttonBase =
  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60';

export function DeckActions({
  deckId,
  deckTitle,
  status,
}: {
  deckId: string;
  deckTitle: string;
  status: DeckStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [downloading, setDownloading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      // Minted on click: the URL is signed and short-lived, so one baked in at
      // render time would already be dead on a card left open in a tab.
      const { url, error: actionError } = await getDeckDownloadUrlAction(deckId);
      if (url) window.location.href = url;
      else setError(actionError ?? 'No download available yet.');
    } finally {
      setDownloading(false);
    }
  }

  if (confirmingDelete) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-neutral-600 dark:text-neutral-300">Delete this deck?</span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteDeckAction(deckId);
              // On success the card disappears with the revalidate, so there is
              // nothing to reset — only a failure needs to be shown.
              if (result.error) {
                setError(result.error);
                setConfirmingDelete(false);
              }
            })
          }
          className={`${buttonBase} bg-red-600 text-white hover:bg-red-500`}
        >
          {pending ? 'Deleting…' : 'Delete'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete(false)}
          className={`${buttonBase} border border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10`}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {status === 'ready' ? (
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className={`${buttonBase} bg-indigo-600 text-white hover:bg-indigo-500`}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2} />
          {downloading ? 'Preparing…' : 'Download'}
        </button>
      ) : null}

      {status !== 'generating' && status !== 'awaiting_review' ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              // A build that cannot even start now says why — don't discard it.
              const result = await regenerateDeckAction(deckId);
              setError(result.error);
            })
          }
          className={`${buttonBase} border border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10`}
        >
          <RotateCw className="h-3.5 w-3.5" strokeWidth={2} />
          {status === 'failed' ? 'Try again' : 'Regenerate'}
        </button>
      ) : null}

      <button
        type="button"
        aria-label={`Delete ${deckTitle}`}
        onClick={() => {
          setError(null);
          setConfirmingDelete(true);
        }}
        className={`${buttonBase} ml-auto text-neutral-500 hover:bg-red-50 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-red-500/10 dark:hover:text-red-400`}
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      {error ? (
        <span className="w-full text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : null}
    </div>
  );
}
