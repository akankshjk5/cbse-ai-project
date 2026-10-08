import type { StyleSpec } from '../types';

/**
 * Slide geometry, in inches.
 *
 * Every position the builder uses comes from here, so "does this fit on the
 * slide?" has one answer rather than a magic number per call site.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The area inside the outer margins that content may occupy. */
export function contentArea(spec: StyleSpec): Box {
  const { slideSize, spacing } = spec;
  const margin = spacing.outerMargin;

  return {
    x: margin,
    y: margin,
    w: slideSize.width - margin * 2,
    h: slideSize.height - margin * 2,
  };
}

/** Splits the content area into `count` evenly gapped columns. */
export function columns(spec: StyleSpec, count: number): Box[] {
  if (count < 1) throw new Error(`columns(): count must be >= 1, got ${count}`);

  const area = contentArea(spec);
  const gap = spec.spacing.elementGap;
  const width = (area.w - gap * (count - 1)) / count;

  return Array.from({ length: count }, (_, i) => ({
    x: area.x + i * (width + gap),
    y: area.y,
    w: width,
    h: area.h,
  }));
}

/**
 * Moves `box` back onto the slide, shrinking it only if it will not fit.
 *
 * A designer working in inches lands a box a tenth of an inch over the edge
 * often enough that treating it as fatal throws away an otherwise good deck —
 * and "slide the box up by 0.1in" is arithmetic, not a judgement, so code
 * should do it rather than spend a revision round asking a model to.
 *
 * Sliding is tried before shrinking, because moving a box preserves the type
 * size inside it and resizing does not.
 */
export function fitToSlide(spec: StyleSpec, box: Box): Box {
  const { width, height } = spec.slideSize;

  const w = Math.min(box.w, width);
  const h = Math.min(box.h, height);

  return {
    x: Math.min(Math.max(box.x, 0), width - w),
    y: Math.min(Math.max(box.y, 0), height - h),
    w,
    h,
  };
}

/** True when two boxes intersect. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when `inner` lies entirely inside `outer`. */
export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 1e-6 &&
    inner.y >= outer.y - 1e-6 &&
    inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
    inner.y + inner.h <= outer.y + outer.h + 1e-6
  );
}

/** Distinct values, ascending, with near-duplicates collapsed. */
function ticks(values: number[]): number[] {
  return values
    .slice()
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || value - all[index - 1] > 1e-6);
}

/**
 * The largest empty rectangle inside `area` that touches none of `occupied`.
 *
 * Used to find somewhere to put a picture on a slide that was designed without
 * one. Guessing at a position instead — "the right half is usually free" —
 * lands an illustration on top of the body copy the moment a designer chooses
 * a layout that is not two-column, and the result is worse than no picture.
 *
 * Exact rather than heuristic: every candidate edge is an edge of `area` or of
 * something already on the slide, so the true maximum is one of the rectangles
 * this enumerates. A slide has fewer than a dozen elements, which puts the
 * search in the tens of thousands of comparisons — far cheaper than the model
 * call it decides the shape of.
 *
 * Returns null when the slide is genuinely full.
 */
export function largestFreeRect(area: Box, occupied: Box[], gap = 0): Box | null {
  // Grown by `gap` so the winning rectangle does not end up flush against its
  // neighbours — a picture butted up against a paragraph reads as a mistake.
  const blocks = occupied.map((box) => ({
    x: box.x - gap,
    y: box.y - gap,
    w: box.w + gap * 2,
    h: box.h + gap * 2,
  }));

  const right = area.x + area.w;
  const bottom = area.y + area.h;

  const xs = ticks(
    [area.x, right, ...blocks.flatMap((b) => [b.x, b.x + b.w])].filter(
      (v) => v >= area.x - 1e-6 && v <= right + 1e-6,
    ),
  );
  const ys = ticks(
    [area.y, bottom, ...blocks.flatMap((b) => [b.y, b.y + b.h])].filter(
      (v) => v >= area.y - 1e-6 && v <= bottom + 1e-6,
    ),
  );

  let best: Box | null = null;

  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      for (let k = 0; k < ys.length - 1; k++) {
        for (let l = k + 1; l < ys.length; l++) {
          const rect = { x: xs[i], y: ys[k], w: xs[j] - xs[i], h: ys[l] - ys[k] };

          if (best && rect.w * rect.h <= best.w * best.h) continue;
          if (blocks.some((block) => overlaps(block, rect))) continue;

          best = rect;
        }
      }
    }
  }

  return best;
}

/** True when `box` lies entirely inside the slide. */
export function isWithinSlide(spec: StyleSpec, box: Box): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= spec.slideSize.width + 1e-6 &&
    box.y + box.h <= spec.slideSize.height + 1e-6
  );
}
