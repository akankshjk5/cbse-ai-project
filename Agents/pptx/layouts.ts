import type { StyleSpec } from '../types';
import type { Box } from './positioning';

/**
 * Named slide layouts, and the rectangles they put things in.
 *
 * ## Why this exists
 *
 * Asking a language model for `{x, y, w, h}` per element is the weakest part of
 * a generation pipeline, and it is weak in a specific, measurable way: the
 * model reads slides fine and cannot build them. On PPTBench (4,439 samples
 * from 958 real decks) GPT-4o scores 94% on understanding a slide and 30% on
 * generating one — and handing it a layout instead of a blank canvas moves
 * generation to 46%, with Gemini-2.0-Flash going 38% → 56%. Every system that
 * produces good decks arranges for the model not to be the last thing that
 * touches geometry, whether by inheriting it from a human-made slide
 * (PPTAgent), hiding it behind semantic calls (AutoPresent), or checking it
 * against a rendering afterwards (Kimi's PPTD skill).
 *
 * So the split here is: **the model chooses the shape of the slide, code
 * computes the rectangles.** Which archetype suits "three everyday examples"
 * is a judgement and stays with the designer. Where three cards go on a
 * 13.333in canvas with a 0.5in margin is arithmetic, and arithmetic that a
 * model does by eye is how a deck ends up with overlapping boxes, a card
 * squeezed to nothing, or an element eight inches off the slide.
 *
 * It is deliberately NOT a template system in the Canva sense. The rectangles
 * are derived from the deck's own StyleSpec — its canvas size, its margins,
 * its gaps — so two decks built from different reference images get different
 * geometry from the same archetype. The look still comes from the reference
 * image; only the arithmetic is fixed.
 *
 * An element that names no slot keeps whatever box the designer gave it, so
 * this is additive: nothing that worked before stops working.
 */

export const LAYOUT_ARCHETYPES = [
  /** Opening slide: title block on the left, tall picture on the right. */
  'title-hero',
  /** Opening slide with no picture — title and subtitle centred in the canvas. */
  'title-only',
  /** Prose on the left, picture on the right. The default content shape. */
  'hero-right',
  /** Picture on the left, prose on the right. */
  'hero-left',
  /** Title, then two equal columns of content. */
  'two-column',
  /** Title, then three cards in a row, then a closing line. */
  'three-column',
  /** Title, then a row of large numbers. */
  'stat-row',
  /** A single centred pull-quote. */
  'quote',
  /** Picture across the whole slide with a text panel over it. */
  'full-bleed',
] as const;

export type LayoutArchetype = (typeof LAYOUT_ARCHETYPES)[number];

/**
 * Slot names an element may claim.
 *
 * Deliberately few. A slot is a role in a layout, not a coordinate — adding
 * more of them re-introduces the freedom this module exists to remove.
 */
export const LAYOUT_SLOTS = [
  'title',
  'subtitle',
  'body',
  'image',
  'col-1',
  'col-2',
  'col-3',
  'caption',
] as const;

export type LayoutSlot = (typeof LAYOUT_SLOTS)[number];

export type SlotMap = Partial<Record<LayoutSlot, Box>>;

/** The measurements every archetype is built from. */
interface Frame {
  /** Content area: the canvas inside its outer margins. */
  x: number;
  y: number;
  w: number;
  h: number;
  gap: number;
  /** Height of a title block at this deck's title size. */
  titleH: number;
  /** Height of a subtitle block. */
  subtitleH: number;
  /** Height of a one-line caption. */
  captionH: number;
}

function frameOf(spec: StyleSpec): Frame {
  const margin = spec.spacing.outerMargin;
  const gap = spec.spacing.sectionGap;

  // Two lines' worth, so a heading that wraps still has room. `shrinkToFit`
  // handles the ones that need three.
  const line = (pt: number) => (pt * 1.25 * 2) / 72;

  return {
    x: margin,
    y: margin,
    w: spec.slideSize.width - margin * 2,
    h: spec.slideSize.height - margin * 2,
    gap,
    titleH: line(spec.typography.title.size),
    subtitleH: line(spec.typography.subtitle?.size ?? spec.typography.body.size * 1.25),
    captionH: line(spec.typography.caption?.size ?? spec.typography.body.size * 0.8),
  };
}

/** `count` equal columns across `width`, separated by `gap`. */
function columns(x: number, width: number, gap: number, count: number): number[] {
  const each = (width - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => x + i * (each + gap));
}

function columnWidth(width: number, gap: number, count: number): number {
  return (width - gap * (count - 1)) / count;
}

/**
 * Share of a hero slide's content width the picture takes.
 *
 * Deliberately more than half. A slide is looked at before it is read, and the
 * pipeline guarantees every slide a picture — so the picture is the larger of
 * the two things on a hero layout, not the thing squeezed in beside the copy.
 * The narrower text column is doing work too: at this width a 20pt line holds
 * roughly forty characters, which is short enough that a designer given a
 * generous word budget cannot quietly turn the column into a paragraph.
 */
const HERO_IMAGE_SHARE = 0.55;

/** Smallest a stacked element may be squeezed to, in inches. Below this it is not a box. */
const MIN_STACK_HEIGHT = 0.28;

/**
 * Splits one slot vertically between the elements that claimed it.
 *
 * A slot is a ROLE, not a coordinate, and more than one element can legitimately
 * play it: the Slide Designer is explicitly asked to put a sub-heading above
 * each group of bullets, so a `three-column` slide arrives with a `label` and a
 * body list both claiming `col-1`. Handing each of them the slot's rectangle
 * drew them on top of one another — the same words in the same place, which is
 * the exact failure archetypes exist to make impossible.
 *
 * `wants` is how much vertical room each element's own text needs, in inches.
 * Where the slot can afford all of them each gets exactly that and the surplus
 * goes to the last one — so a one-line sub-heading gets a one-line box rather
 * than a proportional share of a full-height column, and the list beneath it
 * gets the rest. Where it cannot, every box is scaled back together.
 *
 * Every returned box is inside `slot`, in order, and separated by `gap` — which
 * makes them disjoint by construction, the same property `slotsFor` has.
 */
export function stackInSlot(slot: Box, wants: number[], gap: number): Box[] {
  const count = wants.length;
  if (count === 0) return [];
  if (count === 1) return [{ ...slot }];

  // Gaps first: they are fixed, and what remains is what there is to divide.
  // A slot too short to hold even the minimums gives its gaps up rather than
  // returning boxes with negative height.
  const gapEach = Math.min(gap, Math.max(0, (slot.h - MIN_STACK_HEIGHT * count) / (count - 1)));
  const available = Math.max(0, slot.h - gapEach * (count - 1));
  const floor = Math.min(MIN_STACK_HEIGHT, available / count);

  const asked = wants.map((want) =>
    Math.max(floor, Number.isFinite(want) && want > 0 ? want : floor),
  );
  const total = asked.reduce((sum, want) => sum + want, 0);

  let heights: number[];
  if (total <= available) {
    // Room for everyone. The slack goes to the last element rather than being
    // spread around: it is the body of the group, and a stack that stops short
    // of the slot's bottom edge leaves a ragged row across the slide.
    heights = [...asked];
    heights[count - 1] += available - total;
  } else {
    const scaled = asked.map((want) => Math.max(floor, (want * available) / total));
    const used = scaled.reduce((sum, height) => sum + height, 0);
    // The floor can push the row back over; scale once more so it still ends
    // on the slot's bottom edge.
    heights = used > available ? scaled.map((height) => (height * available) / used) : scaled;
  }

  let y = slot.y;
  return heights.map((height) => {
    const box = { x: slot.x, y, w: slot.w, h: height };
    y += height + gapEach;
    return box;
  });
}

/**
 * The rectangles for one archetype on this deck's canvas.
 *
 * Every slot returned is inside the content area and disjoint from its
 * siblings — that is the property this module is for, and `npm run smoke`
 * asserts it for every archetype rather than trusting the arithmetic below.
 */
export function slotsFor(archetype: LayoutArchetype, spec: StyleSpec): SlotMap {
  const f = frameOf(spec);
  const bottom = f.y + f.h;

  switch (archetype) {
    case 'title-only': {
      // Centred vertically: an opening slide with nothing else on it should not
      // sit hard against the top margin.
      const blockH = f.titleH + f.gap + f.subtitleH;
      const top = f.y + (f.h - blockH) / 2;

      return {
        title: { x: f.x, y: top, w: f.w, h: f.titleH },
        subtitle: { x: f.x, y: top + f.titleH + f.gap, w: f.w, h: f.subtitleH },
      };
    }

    case 'title-hero': {
      const textW = (f.w - f.gap) * (1 - HERO_IMAGE_SHARE);
      const imageX = f.x + textW + f.gap;
      const blockH = f.titleH + f.gap + f.subtitleH + f.gap + f.captionH;
      const top = f.y + Math.max(0, (f.h - blockH) / 2);

      return {
        title: { x: f.x, y: top, w: textW, h: f.titleH },
        subtitle: { x: f.x, y: top + f.titleH + f.gap, w: textW, h: f.subtitleH },
        caption: {
          x: f.x,
          y: top + f.titleH + f.gap + f.subtitleH + f.gap,
          w: textW,
          h: f.captionH,
        },
        image: { x: imageX, y: f.y, w: f.w - textW - f.gap, h: f.h },
      };
    }

    case 'hero-right':
    case 'hero-left': {
      const bodyTop = f.y + f.titleH + f.gap;
      const bodyH = bottom - bodyTop;
      // Not halves: the picture gets the bigger share — see HERO_IMAGE_SHARE.
      const split = f.w - f.gap;
      const imageW = split * HERO_IMAGE_SHARE;
      const textW = split - imageW;
      const imageLeft = archetype === 'hero-left';

      const textX = imageLeft ? f.x + imageW + f.gap : f.x;
      const imageX = imageLeft ? f.x : f.x + textW + f.gap;

      return {
        title: { x: f.x, y: f.y, w: f.w, h: f.titleH },
        body: { x: textX, y: bodyTop, w: textW, h: bodyH - f.captionH - f.gap },
        caption: { x: textX, y: bottom - f.captionH, w: textW, h: f.captionH },
        image: { x: imageX, y: bodyTop, w: imageW, h: bodyH },
      };
    }

    case 'two-column': {
      const top = f.y + f.titleH + f.gap;
      const contentH = bottom - top - f.captionH - f.gap;
      const [c1, c2] = columns(f.x, f.w, f.gap, 2);
      const each = columnWidth(f.w, f.gap, 2);

      return {
        title: { x: f.x, y: f.y, w: f.w, h: f.titleH },
        'col-1': { x: c1, y: top, w: each, h: contentH },
        'col-2': { x: c2, y: top, w: each, h: contentH },
        caption: { x: f.x, y: bottom - f.captionH, w: f.w, h: f.captionH },
      };
    }

    case 'three-column':
    case 'stat-row': {
      const top = f.y + f.titleH + f.gap;
      // A stat row is a band, not a full-height split — big numbers want air
      // around them rather than a tall empty box under them.
      const bandH =
        archetype === 'stat-row'
          ? Math.min(f.h * 0.4, bottom - top - f.captionH - f.gap)
          : bottom - top - f.captionH - f.gap;
      const [c1, c2, c3] = columns(f.x, f.w, f.gap, 3);
      const each = columnWidth(f.w, f.gap, 3);

      return {
        title: { x: f.x, y: f.y, w: f.w, h: f.titleH },
        'col-1': { x: c1, y: top, w: each, h: bandH },
        'col-2': { x: c2, y: top, w: each, h: bandH },
        'col-3': { x: c3, y: top, w: each, h: bandH },
        caption: { x: f.x, y: bottom - f.captionH, w: f.w, h: f.captionH },
      };
    }

    case 'quote': {
      const quoteH = Math.min(f.h * 0.5, f.h - f.captionH - f.gap);
      const top = f.y + (f.h - quoteH - f.captionH - f.gap) / 2;
      // Inset from the margins: a pull-quote that runs the full width reads as
      // body copy that happens to be large.
      const inset = f.w * 0.1;

      return {
        body: { x: f.x + inset, y: top, w: f.w - inset * 2, h: quoteH },
        caption: {
          x: f.x + inset,
          y: top + quoteH + f.gap,
          w: f.w - inset * 2,
          h: f.captionH,
        },
      };
    }

    case 'full-bleed': {
      // The picture is the slide; the text sits in a panel on the lower left.
      const panelW = f.w * 0.55;
      const panelH = f.titleH + f.gap + f.subtitleH;

      return {
        image: { x: 0, y: 0, w: spec.slideSize.width, h: spec.slideSize.height },
        title: { x: f.x, y: bottom - panelH - f.gap, w: panelW, h: f.titleH },
        subtitle: { x: f.x, y: bottom - f.subtitleH, w: panelW, h: f.subtitleH },
      };
    }
  }
}

/** Human-readable description of each archetype, for the designer's prompt. */
export const ARCHETYPE_GUIDE: Record<LayoutArchetype, string> = {
  'title-only': 'Opening slide, no picture. Slots: title, subtitle.',
  'title-hero': 'Opening slide with a tall picture on the right. Slots: title, subtitle, caption, image.',
  'hero-right': 'Prose on the left, picture on the right. Slots: title, body, caption, image.',
  'hero-left': 'Picture on the left, prose on the right. Slots: title, body, caption, image.',
  'two-column': 'Two equal columns under a title. Slots: title, col-1, col-2, caption.',
  'three-column': 'Three cards in a row under a title. Slots: title, col-1, col-2, col-3, caption.',
  'stat-row': 'A row of three large numbers. Slots: title, col-1, col-2, col-3, caption.',
  'quote': 'A single centred pull-quote. Slots: body, caption.',
  'full-bleed': 'Picture across the whole slide, text panel lower-left. Slots: image, title, subtitle.',
};
