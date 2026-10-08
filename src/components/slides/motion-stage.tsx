'use client';

import type { PPTXTheme } from '@agents/pptx/theme-resolve';

import { SlideCanvas } from './slide-canvas';
import type { DeckViewSlide } from '@/lib/slides/deck-view';

/**
 * The stage: one slide, animated, and clickable.
 *
 * `SlideCanvas` stays a pure function of its props — it has no hooks and is
 * rendered on the server in the deck card's thumbnail — so the two things that
 * need a browser live out here instead:
 *
 * 1. **Replaying an entrance.** A CSS animation runs once per element. There is
 *    no honest way to restart one without a new element, so a new `playToken`
 *    re-keys the canvas and the whole slide mounts again. Cheap: the images are
 *    already in the browser's cache.
 * 2. **`click` motion, and picking an element to edit.** Both are one delegated
 *    handler on the stage, resolved through the `data-element-id` every block
 *    already carries for the headless measuring pass. No per-element handlers,
 *    and nothing added to the markup that the .pptx side would have to mirror.
 *
 * In edit mode a click SELECTS rather than zooms — otherwise choosing the
 * element you want to change is also the gesture that animates it, and you can
 * never see it at rest.
 */

export interface MotionStageProps {
  slide: DeckViewSlide;
  theme: PPTXTheme;
  slideSize: { width: number; height: number };
  /** Play entrance motion. Hover and click motion are live regardless. */
  animate: boolean;
  /** Changing this replays the slide's entrances. */
  playToken: number;
  editing: boolean;
  selected: number | null;
  onSelect: (elementId: number) => void;
  /**
   * The frame around the slide. Defaults to the editor's card treatment;
   * presentation mode passes its own, because a rounded border and a drop
   * shadow are furniture, and a projected slide should be the only thing on
   * the screen.
   */
  className?: string;
}

export function MotionStage({
  slide,
  theme,
  slideSize,
  animate,
  playToken,
  editing,
  selected,
  onSelect,
  className = 'relative overflow-hidden rounded-xl border border-black/10 shadow-sm dark:border-white/10',
}: MotionStageProps) {
  const box = selected === null ? null : slide.blocks[selected]?.box;

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-element-id]');
    if (!target) return;

    const elementId = Number(target.dataset.elementId);
    if (!Number.isInteger(elementId)) return;

    if (editing) {
      onSelect(elementId);
      return;
    }

    // A `click` motion is a toggle — click to bring it forward, click again to
    // put it back. `:active` would only hold it while the button is down,
    // which is a twitch rather than an effect anyone can present with.
    if (target.getAttribute('data-motion') === 'click') {
      target.classList.toggle('lm-active');
    }
  }

  return (
    <div className={className} onClick={handleClick}>
      <SlideCanvas
        key={playToken}
        slide={slide}
        theme={theme}
        slideSize={slideSize}
        animate={animate}
      />

      {/* The selection ring is drawn from the element's own box rather than by
          styling the node itself: an outline on a scaling element scales with
          it, and the ring is meant to show where the element LIVES. */}
      {editing && box ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-sm ring-2 ring-indigo-500 ring-offset-1 ring-offset-transparent"
          style={{
            left: `${(box.x / slideSize.width) * 100}%`,
            top: `${(box.y / slideSize.height) * 100}%`,
            width: `${(box.w / slideSize.width) * 100}%`,
            height: `${(box.h / slideSize.height) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}
