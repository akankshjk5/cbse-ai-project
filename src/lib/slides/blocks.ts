import { z } from 'zod';

import { motionSchema } from '@agents/motion';
import { LAYOUT_SLOTS } from '@agents/pptx/layouts';

/**
 * A slide's stored content, as the web renderer sees it.
 *
 * `slides.blocks` is the pipeline's `SlideElement[]` after one substitution:
 * every `imagePath` — an absolute path inside a temp directory on the build
 * machine — is replaced by `imageUrl`, the public CDN URL of the same picture.
 *
 * That substitution is not cosmetic. A local path is useless to a browser and
 * has no business being handed to one, so the swap happens once, in
 * `replaceSlides`, rather than being worked around by every consumer.
 *
 * Parsed rather than cast, because `blocks` is `jsonb`: the schema check the
 * pipeline did before writing does not survive the round trip through
 * Postgres, and a renderer that trusts `Json` will crash on the first row
 * written by an older build.
 */

const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

/** Already normalised to `#rrggbb` by the pipeline before it was stored. */
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i).optional().catch(undefined);

export const SLIDE_BLOCK_TYPES = [
  'text',
  'image',
  'shape',
  'card',
  'statistic',
  'diagram',
  'chart',
  'divider',
] as const;

export const slideBlockSchema = z.object({
  type: z.enum(SLIDE_BLOCK_TYPES).catch('text'),
  /** Semantic role — 'title' | 'body' | 'caption' — drives which size applies. */
  role: z.string().default('body'),
  /** Position and size in inches, on the deck's own canvas. */
  box: boxSchema,
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  /** Public URL of the generated picture. Null when generation failed. */
  imageUrl: z.string().nullish(),
  /** Optional generated motion version; the still remains the export/poster. */
  videoUrl: z.string().url().nullish(),
  /** What the picture was asked to show. Useful as alt text. */
  imagePrompt: z.string().optional(),
  /**
   * Explicit alignment, when the designer asked for one. Normally absent —
   * `placementFor` supplies the conventional placement for the role, and the
   * .pptx builder reads the same function, so the two agree by construction.
   */
  align: z.enum(['left', 'center', 'right']).optional().catch(undefined),
  valign: z.enum(['top', 'middle', 'bottom']).optional().catch(undefined),
  /**
   * The type size the pipeline measured for this element, in points.
   *
   * Absent on decks built before the measuring pass, in which case the
   * renderer falls back to the theme size for the role and its own estimate.
   */
  fontSize: z.number().positive().optional().catch(undefined),
  /** Per-element text-colour preference. Mirrors `SlideElement.color`. */
  color: hexColor,
  /** Per-element fill preference, `card`/`shape` only. Mirrors `SlideElement.fill`. */
  fill: hexColor,
  /**
   * The archetype layout slot this element fills, e.g. `'title'` / `'image'`
   * / `'col-2'`. Mirrors `SlideElement.slot` (Agents/types.ts).
   *
   * Only consulted by `SlideCanvas` in `viewportMode: 'export'`, where it
   * routes the element into a named CSS Grid area (see
   * `Agents/pptx/archetype-grid.ts`) instead of the absolute `box` position —
   * that is what makes text and image regions disjoint by construction
   * rather than by an overlap check run after the fact. Absent on decks
   * persisted before this field existed, and in `viewportMode: 'live'` where
   * it is never read.
   */
  slot: z.enum(LAYOUT_SLOTS).optional().catch(undefined),
  /**
   * How this element moves in the browser. Mirrors `SlideElement.motion`.
   *
   * Written by the pipeline (`ensureSlideMotion`) and editable afterwards from
   * the viewer's animation panel, which writes back to this same jsonb through
   * `setSlideMotion`. Read only by `SlideCanvas` in `viewportMode: 'live'`;
   * the .pptx has no animations to disagree with.
   */
  motion: motionSchema.optional().catch(undefined),
});

export type SlideBlock = z.infer<typeof slideBlockSchema>;

/**
 * Reads `slides.blocks` into something renderable.
 *
 * Individually tolerant: one malformed block is dropped, and the rest of the
 * slide still renders. A deck that lost a divider is a deck; a viewer that
 * throws on one bad row shows the user nothing at all.
 */
export function parseBlocks(value: unknown): SlideBlock[] {
  return parseBlocksWithIndex(value).map(({ block }) => block);
}

/**
 * The same parse, keeping each block's position in the stored array.
 *
 * The editor addresses an element by where it sits in the rendered slide, and
 * the writer has to put the change back into the *stored* jsonb. Those two
 * numbers are equal right up until one malformed block is dropped, at which
 * point every index after it is off by one and an edit lands on the wrong
 * element — silently, since both are valid elements. Carrying the source index
 * through is the only version of this that cannot drift.
 */
export function parseBlocksWithIndex(value: unknown): { block: SlideBlock; index: number }[] {
  if (!Array.isArray(value)) return [];

  const blocks: { block: SlideBlock; index: number }[] = [];
  value.forEach((entry, index) => {
    const parsed = slideBlockSchema.safeParse(entry);
    if (parsed.success) blocks.push({ block: parsed.data, index });
  });
  return blocks;
}
