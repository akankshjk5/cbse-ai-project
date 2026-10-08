'use client';

import { ChevronLeft, ChevronRight, StickyNote, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PPTXTheme } from '@agents/pptx/theme-resolve';

import { MotionStage } from './motion-stage';
import type { DeckViewSlide } from '@/lib/slides/deck-view';

/**
 * Presentation mode: the deck and nothing else.
 *
 * A separate surface rather than a class on the editor, because presenting is
 * a different job from building. Everything the editor needs on screen — the
 * rail, the toolbar, the animation panel, the page's own header — is furniture
 * in front of an audience, and a mode that merely hides some of it tends to
 * keep whichever piece nobody remembered.
 *
 * ## What it does that the editor cannot
 *
 * - **Fills the screen.** Real fullscreen where the browser allows it, and a
 *   fixed overlay regardless, so a refused or unavailable Fullscreen API
 *   degrades to a black page with the slide on it rather than to nothing.
 *   The slide is sized from the deck's own aspect ratio — `min()` against both
 *   viewport axes — so it is as large as it can be without being cropped, on
 *   any screen and either orientation.
 * - **Answers a remote.** Space, arrows, Page Up/Down, Home/End, and Escape.
 *   A presentation remote sends Page Up/Down; a keyboard sends arrows; almost
 *   everyone reaches for Space. All three are the same two verbs.
 * - **Gets out of the way.** The controls and the cursor fade after a moment
 *   of stillness and come back on the first movement. A toolbar sitting over a
 *   projected slide is the thing that makes a good deck look unfinished.
 * - **Plays the motion.** Each slide's entrance replays on arrival — this is
 *   the mode the animation was designed in, so it is the mode where it has to
 *   be exactly what the editor previewed. Same `MotionStage`, same renderer,
 *   `animate` on, `editing` off: a click zooms an element rather than
 *   selecting it.
 */

export interface PresentModeProps {
  slides: DeckViewSlide[];
  theme: PPTXTheme;
  slideSize: { width: number; height: number };
  index: number;
  onIndex: (next: number) => void;
  /** Changing this replays the current slide's entrances. */
  playToken: number;
  onExit: () => void;
}

/** How long the screen must be still before the controls and cursor go away. */
const IDLE_MS = 2500;

export function PresentMode({
  slides,
  theme,
  slideSize,
  index,
  onIndex,
  playToken,
  onExit,
}: PresentModeProps) {
  const root = useRef<HTMLDivElement>(null);
  const [chrome, setChrome] = useState(true);
  const [showNotes, setShowNotes] = useState(false);

  const slide = slides[index];
  const count = slides.length;

  /**
   * Ask for real fullscreen on the way in, and give it back on the way out.
   *
   * Both are best-effort on purpose. The request rejects when it was not
   * driven by a gesture the browser trusts, and `exitFullscreen` throws if
   * something else already left — neither is a reason to fail out of a mode
   * that works without it.
   */
  useEffect(() => {
    const element = root.current;
    void element?.requestFullscreen?.().catch(() => {});

    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  /**
   * Leaving fullscreen leaves the mode.
   *
   * Escape is handled by the browser before any key listener sees it, so
   * without this the overlay would survive the gesture everyone uses to close
   * it — a black screen the user cannot get out of by the obvious means.
   */
  useEffect(() => {
    function onChange() {
      if (!document.fullscreenElement) onExit();
    }

    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [onExit]);

  const wake = useCallback(() => setChrome(true), []);

  useEffect(() => {
    if (!chrome) return;

    const timer = window.setTimeout(() => setChrome(false), IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [chrome, index]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      switch (event.key) {
        case ' ':
        case 'Spacebar':
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          onIndex(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          onIndex(index - 1);
          break;
        case 'Home':
          onIndex(0);
          break;
        case 'End':
          onIndex(count - 1);
          break;
        case 'Escape':
          // Only reached when the overlay is not actually fullscreen — the
          // browser eats Escape otherwise, and `fullscreenchange` covers it.
          onExit();
          break;
        case 'n':
        case 'N':
          setShowNotes((open) => !open);
          break;
        default:
          return;
      }

      wake();
      event.preventDefault();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onIndex, onExit, wake]);

  if (!slide) return null;

  return (
    <div
      ref={root}
      onMouseMove={wake}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black ${
        chrome ? '' : 'cursor-none'
      }`}
    >
      {/* As large as the deck's own ratio allows on this screen, never cropped. */}
      <div
        style={{
          width: `min(100vw, ${(slideSize.width / slideSize.height).toFixed(4)} * 100vh)`,
        }}
      >
        <MotionStage
          slide={slide}
          theme={theme}
          slideSize={slideSize}
          animate
          playToken={playToken}
          editing={false}
          selected={null}
          onSelect={() => {}}
          className="relative overflow-hidden"
        />
      </div>

      {showNotes && slide.speakerNotes ? (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 max-h-[28vh] overflow-y-auto bg-black/80 px-8 py-4 text-sm leading-relaxed text-neutral-100">
          {slide.speakerNotes}
        </p>
      ) : null}

      <div
        className={`absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/10 px-2 py-1.5 backdrop-blur transition-opacity ${
          chrome ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={() => onIndex(index - 1)}
          disabled={index === 0}
          aria-label="Previous slide"
          className="rounded-full p-1.5 text-white transition-colors hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
        </button>

        <span className="min-w-14 text-center text-xs tabular-nums text-white/80">
          {index + 1} / {count}
        </span>

        <button
          type="button"
          onClick={() => onIndex(index + 1)}
          disabled={index === count - 1}
          aria-label="Next slide"
          className="rounded-full p-1.5 text-white transition-colors hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </button>

        {slide.speakerNotes ? (
          <button
            type="button"
            onClick={() => setShowNotes((open) => !open)}
            aria-label="Speaker notes"
            title="Speaker notes (N)"
            className={`rounded-full p-1.5 transition-colors hover:bg-white/20 ${
              showNotes ? 'bg-white/25 text-white' : 'text-white/80'
            }`}
          >
            <StickyNote className="h-4 w-4" strokeWidth={2} />
          </button>
        ) : null}

        <button
          type="button"
          onClick={onExit}
          aria-label="Leave presentation"
          title="Leave presentation (Esc)"
          className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
