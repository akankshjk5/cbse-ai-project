'use client';

import { ChevronLeft, ChevronRight, Play, StickyNote, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import type { Motion } from '@agents/motion';

import { AnimationEditor } from './animation-editor';
import { MotionStage } from './motion-stage';
import { PresentMode } from './present-mode';
import { SlideCanvas } from './slide-canvas';
import { updateSlideMotionAction } from '@/lib/actions/slides';
import type { DeckView, DeckViewSlide } from '@/lib/slides/deck-view';

/**
 * The deck, on screen.
 *
 * A rail of thumbnails and one large stage, both drawn by the same
 * `SlideCanvas` — so what the thumbnail shows and what the stage shows cannot
 * disagree, and neither can disagree with the .pptx.
 *
 * Client-side only because of the things that need to be: arrow keys, which
 * slide you are on, and the animation editor's unsaved edits. The slides
 * themselves arrive as props, already read and parsed on the server.
 *
 * ## Editing motion
 *
 * Edits are held here as a per-slide overlay and merged into the blocks handed
 * to the stage, so the preview IS the thing being edited — moving a slider
 * replays against the real renderer rather than against a mock of it. Nothing
 * is written until Save, and Save posts only the slides that actually changed.
 * The rail keeps drawing the unedited, unanimated slides: six thumbnails
 * zooming at once is noise, and a thumbnail's job is to say which slide it is.
 */
export function DeckViewer({ view, deckId }: { view: DeckView; deckId?: string }) {
  const [index, setIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);

  // Motion. `playToken` re-keys the stage, which is how an entrance replays —
  // see `MotionStage`.
  const [presenting, setPresenting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [playToken, setPlayToken] = useState(0);
  /** slide index → element index → its edited motion. Unsaved. */
  const [drafts, setDrafts] = useState<Record<number, Record<number, Motion>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const count = view.slides.length;

  const go = useCallback(
    (next: number) =>
      setIndex((current) => {
        const target = Math.min(count - 1, Math.max(0, next ?? current));
        if (target !== current) {
          setSelected(null);
          // A slide you have just arrived at should play, the same as it will
          // when the deck is presented.
          setPlayToken((token) => token + 1);
        }
        return target;
      }),
    [count],
  );

  useEffect(() => {
    // Presentation mode binds its own, wider set (Space, Page Up/Down, Escape).
    // Leaving this one attached would advance the deck twice per key.
    if (presenting) return;

    function onKey(event: KeyboardEvent) {
      // Let the browser have the keys while someone is typing somewhere.
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable]')) return;

      if (event.key === 'ArrowRight' || event.key === 'PageDown') go(index + 1);
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') go(index - 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(count - 1);
      else return;

      event.preventDefault();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, count, presenting]);

  /** The slides as they would be with the unsaved edits applied. */
  const edited: DeckViewSlide[] = useMemo(
    () =>
      view.slides.map((slide, position) => {
        const overlay = drafts[position];
        if (!overlay) return slide;

        return {
          ...slide,
          blocks: slide.blocks.map((block, elementId) =>
            overlay[elementId] ? { ...block, motion: overlay[elementId] } : block,
          ),
        };
      }),
    [view.slides, drafts],
  );

  if (count === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        This deck has no slides yet.
      </p>
    );
  }

  const slide = edited[index];
  const dirty = Object.keys(drafts).length > 0;

  function change(elementId: number, motion: Motion) {
    setDrafts((current) => ({
      ...current,
      [index]: { ...(current[index] ?? {}), [elementId]: motion },
    }));
    setSaveError(null);
    // Replay so the change is visible immediately — an entrance you cannot see
    // without pressing a button is an edit made blind.
    setPlayToken((token) => token + 1);
  }

  function applyAll(motion: Motion) {
    setDrafts((current) => ({
      ...current,
      [index]: Object.fromEntries(
        slide.blocks.map((block, elementId) => [
          elementId,
          // Each element keeps the delay the cascade gave it, so applying one
          // effect everywhere does not collapse the slide into a single beat.
          { ...motion, delay: block.motion?.delay ?? motion.delay },
        ]),
      ),
    }));
    setSaveError(null);
    setPlayToken((token) => token + 1);
  }

  function save() {
    if (!deckId) return;

    const pending = Object.entries(drafts);
    startSaving(async () => {
      for (const [position, motions] of pending) {
        const result = await updateSlideMotionAction({
          deckId,
          position: Number(position),
          motions,
        });

        if (result.error) {
          setSaveError(result.error);
          return;
        }
      }

      // Only cleared once every slide landed: a half-saved deck that looks
      // saved is how someone loses the other half.
      setDrafts({});
      setSaveError(null);
    });
  }

  return (
    <div className="flex gap-5">
      {/* Rail */}
      <ol className="hidden max-h-[calc(100vh-11rem)] w-[152px] shrink-0 space-y-2 overflow-y-auto pr-1 lg:block">
        {view.slides.map((thumbnail, position) => (
          <li key={position}>
            <button
              type="button"
              onClick={() => go(position)}
              aria-current={position === index}
              aria-label={`Slide ${position + 1}${thumbnail.title ? `: ${thumbnail.title}` : ''}`}
              className={`flex w-full items-start gap-1.5 rounded-lg p-1 text-left transition-colors ${
                position === index
                  ? 'bg-indigo-50 dark:bg-indigo-500/15'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <span className="w-4 shrink-0 pt-1 text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">
                {position + 1}
              </span>
              <span
                className={`block flex-1 overflow-hidden rounded border ${
                  position === index
                    ? 'border-indigo-400 dark:border-indigo-500'
                    : 'border-black/10 dark:border-white/10'
                }`}
              >
                <SlideCanvas
                  slide={thumbnail}
                  theme={view.theme}
                  slideSize={view.slideSize}
                />
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* Stage */}
      <div className="min-w-0 flex-1">
        <MotionStage
          slide={slide}
          theme={view.theme}
          slideSize={view.slideSize}
          animate
          playToken={playToken}
          editing={editing}
          selected={selected}
          onSelect={setSelected}
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label="Previous slide"
            className="rounded-lg border border-black/10 p-1.5 transition-colors hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/10"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            disabled={index === count - 1}
            aria-label="Next slide"
            className="rounded-lg border border-black/10 p-1.5 transition-colors hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/10"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>

          <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
            {index + 1} / {count}
          </span>

          <button
            type="button"
            onClick={() => {
              // Editing and presenting are different jobs; the panel has no
              // business surviving into the room.
              setEditing(false);
              setSelected(null);
              setPresenting(true);
              setPlayToken((token) => token + 1);
            }}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2} />
            Present
          </button>

          {deckId ? (
            <button
              type="button"
              onClick={() => {
                setEditing((open) => !open);
                setSelected(null);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                editing
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'border border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10'
              }`}
            >
              <Wand2 className="h-3.5 w-3.5" strokeWidth={2} />
              Animation
              {dirty ? <span className="text-[10px] opacity-80">• unsaved</span> : null}
            </button>
          ) : null}

          {slide.speakerNotes ? (
            <button
              type="button"
              onClick={() => setShowNotes((open) => !open)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                showNotes
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'border border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10'
              }`}
            >
              <StickyNote className="h-3.5 w-3.5" strokeWidth={2} />
              Notes
            </button>
          ) : null}
        </div>

        {showNotes && slide.speakerNotes ? (
          <p className="mt-3 whitespace-pre-wrap rounded-lg border border-black/10 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-300">
            {slide.speakerNotes}
          </p>
        ) : null}

      </div>

      {/* Presented from the edited slides, so an animation you have not saved
          yet is still the animation you rehearse with. */}
      {presenting ? (
        <PresentMode
          slides={edited}
          theme={view.theme}
          slideSize={view.slideSize}
          index={index}
          onIndex={go}
          playToken={playToken}
          onExit={() => setPresenting(false)}
        />
      ) : null}

      {editing && deckId ? (
        <AnimationEditor
          blocks={slide.blocks}
          selected={selected}
          onSelect={setSelected}
          onChange={change}
          onApplyAll={applyAll}
          onReplay={() => setPlayToken((token) => token + 1)}
          onReset={() => {
            setDrafts({});
            setSaveError(null);
            setPlayToken((token) => token + 1);
          }}
          onSave={save}
          saving={saving}
          dirty={dirty}
          error={saveError}
        />
      ) : null}
    </div>
  );
}
