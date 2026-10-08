/**
 * The layout-estimation half of the old theme module.
 *
 * Everything here exists to predict, in code, what a real layout engine would
 * do — where text wraps, how far it has to shrink to fit a box, how a block
 * should align inside it. `Agents/pptx/browser-layout.ts` now asks an actual
 * browser those questions instead of estimating them, which is strictly more
 * accurate. This module survives only until every caller has moved to that
 * path (see the migration plan); at that point `placementFor`, `shrinkToFit`
 * and `estimateLines`/`estimateTextHeight` are dead code and this file goes
 * away. `readableOn`, the legibility floors and `themeFromStyleSpec` moved to
 * `./theme-resolve` because those are business rules a browser can't invent on
 * its own, and still run before every render.
 */

// ── Alignment ────────────────────────────────────────────────────────────────

export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

export interface TextPlacement {
  align: Align;
  valign: VAlign;
}

/** Beyond this many words, a card is carrying prose rather than a label. */
const LABEL_WORDS = 8;

/**
 * Where text sits inside its box, by element type, role and content.
 *
 * Shared by the .pptx builder and the web renderer so the two cannot drift.
 * They were previously aligning text independently — the builder hard-coded
 * `valign: 'top'` and centred card labels, the browser relied on whatever the
 * CSS default happened to be — which agreed by luck rather than design, and
 * only for the cases that had been looked at.
 *
 * The rules are the conventional ones: prose reads from the left, a number or
 * a short label in a box is centred in it. `content` is what decides which of
 * those a card is — centred text is only comfortable while it stays on one or
 * two lines, and a card explaining itself in twenty words is prose whatever
 * box it happens to sit in. Ragging both edges of a paragraph to centre it is
 * the single fastest way to make a slide look amateur, and it is exactly what
 * happens when a row of cards is centred by type alone.
 *
 * A designer that wants something else says so on the element, and both
 * renderers honour it.
 */
export function placementFor(
  type: string,
  role: string,
  content?: { text?: string; items?: string[] },
): TextPlacement {
  // A statistic is a display number: it is the thing being looked at.
  if (type === 'statistic' || role === 'statistic' || role === 'stat') {
    return { align: 'center', valign: 'middle' };
  }

  if (role === 'quote') return { align: 'center', valign: 'middle' };

  if (type === 'card' || type === 'shape') {
    // A list always reads from a common left edge — that is what makes it
    // scannable as a list rather than as three separate sentences.
    if ((content?.items?.length ?? 0) > 1) return { align: 'left', valign: 'top' };

    const words = [content?.text, ...(content?.items ?? [])]
      .filter(Boolean)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;

    return words > LABEL_WORDS
      ? { align: 'left', valign: 'top' }
      : { align: 'center', valign: 'middle' };
  }

  // Everything else is prose, and prose reads from the left edge, top down.
  return { align: 'left', valign: 'top' };
}

// ── Fitting text to its box ──────────────────────────────────────────────────

/**
 * Rough characters-per-line for a box of `widthInches` at `fontSizePt`.
 *
 * There is no font-metrics engine here, so this is an estimate — but it is the
 * SAME estimate everywhere: the layout check that flags overflow, the pass that
 * grows a box, and the two renderers that have to fit text into whatever is
 * left. One approximation shared is far better than three that disagree.
 */
export function estimateLines(text: string, widthInches: number, fontSizePt: number): number {
  const charWidthInches = (fontSizePt * glyphWidthFactor(text, fontSizePt)) / 72;
  const usable = widthInches * (1 - SAFETY_MARGIN);
  const charsPerLine = Math.max(1, Math.floor(usable / charWidthInches));
  return Math.ceil(text.length / charsPerLine);
}

/**
 * How much room the estimate holds back, because it is an estimate.
 *
 * There is no font-metrics engine here, so glyph width is a constant per
 * casing — and a real typeface is not a constant. Playfair Display, which the
 * font curator picks for exactly the decks that want a display serif, runs
 * appreciably wider than the average this assumes.
 *
 * At the boundary that is the difference between "21 characters fit on one
 * line" and a second line that the box has no room for. Being 6% pessimistic
 * costs a heading one step of shrink it might not have needed; being
 * optimistic costs it the last word, silently. The trade is not close.
 */
const SAFETY_MARGIN = 0.06;

/**
 * Average glyph width, as a fraction of the point size.
 *
 * ~0.5 is the usual figure for mixed-case prose, and it is wrong by a mile for
 * a heading — capitals are broader, and a StyleSpec that asks for uppercase
 * titles gets them from the designer as `THE MUGHAL EMPIRE`. Treating that as
 * mixed-case underestimates its width by a quarter, which is exactly enough to
 * decide a two-line heading fits on one and let it run over the subtitle.
 */
function glyphWidthFactor(text: string, fontSizePt: number): number {
  // Type this large is display type, set in the heading face — and heading
  // faces are wide. Playfair Display, which the curator reaches for whenever a
  // reference image has serifs in it, measures around 0.6em per character
  // against the 0.5 a text face averages. Using one number for both is how a
  // 21-character heading gets measured as fitting a line it overruns.
  const base = fontSizePt >= 28 ? 0.58 : 0.5;

  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return base;

  const upper = letters.replace(/[^\p{Lu}]/gu, '').length / letters.length;
  return base + 0.14 * upper;
}

/** Height a run of text needs in `widthInches` at `fontSizePt`, in inches. */
export function estimateTextHeight(
  text: string,
  widthInches: number,
  fontSizePt: number,
): number {
  return (estimateLines(text, widthInches, fontSizePt) * fontSizePt * 1.2) / 72;
}

/** Type is never shrunk below this fraction of its intended size. */
const MIN_SHRINK = 0.62;

/**
 * How far to shrink type so it fits the box it was given.
 *
 * PowerPoint does this natively — `fit: 'shrink'` on a text box — and the
 * browser has no equivalent, so the factor is computed here and the .pptx and
 * the web renderer both apply it. Without it the two disagree exactly where it
 * is most visible: PowerPoint quietly reflows an overlong heading and the
 * preview lets it run over the subtitle beneath.
 *
 * Bounded, because past a point shrinking is not a fix. A heading at 62% is
 * still a heading; at 40% it is a mistake wearing a heading's box, and the
 * layout check should be left to report it.
 */
export function shrinkToFit(
  text: string,
  box: { w: number; h: number },
  fontSizePt: number,
): number {
  if (!text) return 1;

  // The same pessimism as `SAFETY_MARGIN`, applied to height: a line that only
  // just fits is a line that wraps once the real typeface disagrees with the
  // estimate by a hair.
  const usable = box.h * (1 - SAFETY_MARGIN);
  if (estimateTextHeight(text, box.w, fontSizePt) <= usable) return 1;

  // Stepped down rather than solved. The line count comes from a `ceil`, so it
  // is a step function of the size, and a closed-form ratio lands between two
  // steps and returns a factor that leaves the text still overflowing — which
  // is worse than not shrinking at all, because it looks deliberate.
  for (let factor = 0.96; factor >= MIN_SHRINK; factor -= 0.04) {
    if (estimateTextHeight(text, box.w, fontSizePt * factor) <= usable) return factor;
  }

  // Nothing in range fits. The floor is returned rather than something smaller
  // because past it shrinking has stopped being a fix, and the layout check
  // should be left to report the slide as the design problem it is.
  return MIN_SHRINK;
}
