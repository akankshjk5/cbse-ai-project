import type { LayoutArchetype, LayoutSlot } from './layouts';

/**
 * Archetype → CSS Grid template. The browser-render replacement for
 * `slotsFor`'s hand-computed rectangles.
 *
 * `slotsFor` (./layouts.ts) has to guess a title's height before it knows
 * what the title says, because it runs before any browser measures anything
 * — hence `titleH`/`subtitleH`/`captionH`, two-lines'-worth guesses corrected
 * later by `growTextBoxes`/`compactTitleBand`. A CSS Grid with `auto` rows
 * does not have to guess: a row is exactly as tall as the tallest thing in
 * it, for every browser that has ever rendered a page. Handing that same job
 * to `grid-template-areas` removes the guess and, with it, the two patches
 * that existed only to correct it.
 *
 * The stronger property this buys, and the reason it exists: a named grid
 * area is disjoint from its siblings BY CONSTRUCTION. `slotsFor`'s rectangles
 * are checked for overlap after the fact (`npm run smoke`, `isWithinSlide`,
 * `overlaps`); a grid cannot produce an overlapping layout in the first
 * place, so there is nothing there to check. That is what actually prevents
 * a heading from drifting onto a picture, not a wider safety margin.
 *
 * Used only by `viewportMode: 'export'` in `SlideCanvas` — i.e. only inside
 * `Agents/pptx/browser-layout.ts`'s headless-browser pass. The live web app
 * still positions from the pipeline's own resolved `box` values, unchanged.
 */
export interface ArchetypeGrid {
  /** `grid-template-columns`. */
  columns: string;
  /** `grid-template-rows`, one token per row in `areas`. */
  rows: string;
  /** One string per row, each a space-separated list of `LayoutSlot` names or `.` for empty. */
  areas: string[];
  /**
   * Slots painted as a full-bleed absolutely-positioned layer BEHIND the grid
   * instead of as a grid cell — only `full-bleed`'s `image` needs this: a
   * picture the grid's text sits on top of, not beside.
   */
  floatSlots?: LayoutSlot[];
  /** Vertical placement of the grid's own content block within the slide. */
  alignContent?: 'start' | 'center' | 'end';
  /** Horizontal placement of a narrower-than-full-width grid (`full-bleed`'s text panel). */
  justifyContent?: 'start' | 'center' | 'end';
  /** Grid width as a fraction of the content area, for a panel narrower than the slide. */
  widthFraction?: number;
}

/**
 * The hero split, as grid tracks. Mirrors `HERO_IMAGE_SHARE` in ./layouts so
 * the two engines put the picture in the same place — 45% copy, 55% picture.
 */
const HERO_TEXT_TRACK = '45fr';
const HERO_IMAGE_TRACK = '55fr';

export const ARCHETYPE_GRIDS: Record<LayoutArchetype, ArchetypeGrid> = {
  'title-only': {
    columns: '1fr',
    rows: 'auto auto',
    areas: ['title', 'subtitle'],
    alignContent: 'center',
  },

  'title-hero': {
    columns: `${HERO_TEXT_TRACK} ${HERO_IMAGE_TRACK}`,
    rows: 'auto auto auto',
    areas: ['title image', 'subtitle image', 'caption image'],
    alignContent: 'center',
  },

  'hero-right': {
    columns: `${HERO_TEXT_TRACK} ${HERO_IMAGE_TRACK}`,
    rows: 'auto 1fr auto',
    areas: ['title title', 'body image', 'caption image'],
  },

  'hero-left': {
    columns: `${HERO_IMAGE_TRACK} ${HERO_TEXT_TRACK}`,
    rows: 'auto 1fr auto',
    areas: ['title title', 'image body', 'image caption'],
  },

  'two-column': {
    columns: '1fr 1fr',
    rows: 'auto 1fr auto',
    areas: ['title title', 'col-1 col-2', 'caption caption'],
  },

  'three-column': {
    columns: '1fr 1fr 1fr',
    rows: 'auto 1fr auto',
    areas: ['title title title', 'col-1 col-2 col-3', 'caption caption caption'],
  },

  'stat-row': {
    columns: '1fr 1fr 1fr',
    rows: 'auto auto auto',
    areas: ['title title title', 'col-1 col-2 col-3', 'caption caption caption'],
  },

  quote: {
    columns: '1fr',
    rows: 'auto auto',
    areas: ['body', 'caption'],
    alignContent: 'center',
    justifyContent: 'center',
    widthFraction: 0.8, // slotsFor insets 10% each side — 80% of the content area remains.
  },

  'full-bleed': {
    columns: '1fr',
    rows: 'auto auto',
    areas: ['title', 'subtitle'],
    floatSlots: ['image'],
    alignContent: 'end',
    justifyContent: 'start',
    widthFraction: 0.55,
  },
};
