import type { StyleSpec } from '../types';

/**
 * StyleSpec → concrete, legible theme. The half of `./theme` that survives the
 * headless-browser migration.
 *
 * `placementFor`/`shrinkToFit`/`estimateLines` (still in `./theme`) exist to
 * fake what a real layout engine does for free, and go away once
 * `browser-layout.ts` asks an actual browser to lay a slide out. Colour
 * resolution and legibility floors are different: they are business rules a
 * browser cannot invent on its own — "never below 18pt", "substitute the most
 * readable colour in the palette" — so they still have to run, just earlier:
 * before the render, as the values the HTML template and its in-page
 * shrink-to-fit loop are handed rather than something computed after the fact.
 */
export interface PPTXTheme {
  fonts: {
    heading: string;
    body: string;
    /**
     * Ordered fallbacks from the Font Curator, ending in a font every machine
     * has. PowerPoint names one typeface per run, so the builder cannot use a
     * chain — these are carried for the web preview and for a future embedded-
     * font step, and are what `fontStack` reads.
     */
    headingFallbacks: string[];
    bodyFallbacks: string[];
  };
  colors: {
    background: string;
    text: string;
    secondaryText: string;
    accent: string;
    surface: string;
    border: string;
  };
  sizes: { title: number; subtitle: number; body: number; caption: number };
  spacing: {
    outerMargin: number;
    sectionGap: number;
    elementGap: number;
    paragraphGap: number;
  };
}

/**
 * CSS font stack for `heading` or `body` — the curated family followed by its
 * fallbacks. For the web preview; PowerPoint takes `theme.fonts.heading` alone.
 */
export function fontStack(theme: PPTXTheme, role: 'heading' | 'body'): string {
  const family = role === 'heading' ? theme.fonts.heading : theme.fonts.body;
  const fallbacks = role === 'heading' ? theme.fonts.headingFallbacks : theme.fonts.bodyFallbacks;

  return [family, ...fallbacks]
    // A family with a space needs quoting, or the browser reads it as two names.
    .map((name) => (/\s/.test(name) ? `"${name}"` : name))
    .join(', ');
}

// ── Contrast ─────────────────────────────────────────────────────────────────

/** sRGB channel → linear, per WCAG 2.1. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour, 0-1, per WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;

  const value = Number.parseInt(match[1], 16);
  return (
    0.2126 * linearise((value >> 16) & 255) +
    0.7152 * linearise((value >> 8) & 255) +
    0.0722 * linearise(value & 255)
  );
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const light = Math.max(relativeLuminance(a), relativeLuminance(b));
  const dark = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA for body text. Large display type gets away with 3.0; this is stricter. */
export const MIN_CONTRAST = 4.5;

/**
 * The least scrim a generated backdrop may have.
 *
 * The Background Designer picks a `dim`, and left alone it picks for looks —
 * 0.25 on a busy pattern, which leaves the pattern at three-quarters strength
 * with the deck's copy sitting directly on it. Everything downstream then
 * reasons about text colour as if the background were the deck's background
 * colour, which at that dim is simply false, and the slide ships with a
 * caption nobody can read.
 *
 * This is the floor that makes the assumption true, applied both when a deck
 * is built and when one already in the database is drawn. It is a real
 * constraint on the design, and it is the right way round: a backdrop exists
 * to sit behind words.
 */
export const MIN_BACKDROP_DIM = 0.55;

/**
 * Opacity of the panel laid behind text that sits on top of a picture.
 *
 * `readableOn` can only reason about a colour, and a photograph is not one. A
 * caption over a full-bleed illustration is legible or not depending on which
 * part of the picture happens to be under which word — which is to say, not
 * reliably, and not in a way any check can predict.
 *
 * So the picture is covered where the words are. High enough that the text is
 * back on a known colour and `readableOn` means something again; short of
 * opaque so the panel still reads as part of the image rather than a box
 * dropped on it.
 */
export const TEXT_SCRIM_OPACITY = 0.82;

/**
 * The intended colour, or the palette's most readable substitute for it.
 *
 * The theme assigns a colour per role and stops there, which is right until an
 * element sits somewhere other than the slide background — inside a surface
 * card, or over a generated backdrop. Then "secondary text is #a3b5c6" can
 * quietly mean grey-on-grey, and nothing downstream notices: the builder draws
 * it, the validator passes it, and it ships as a slide with an invisible line
 * on it.
 *
 * So the colour is checked against what is actually behind it. If it clears
 * AA it is used untouched — the design is not second-guessed. If it does not,
 * the most readable colour in the deck's own palette wins, because a
 * substitution from the reference image's palette still looks like the deck
 * and an unreadable line does not.
 */
export function readableOn(preferred: string, background: string, theme: PPTXTheme): string {
  if (contrastRatio(preferred, background) >= MIN_CONTRAST) return preferred;

  const candidates = [
    theme.colors.text,
    theme.colors.background,
    theme.colors.secondaryText,
    theme.colors.accent,
    theme.colors.surface,
  ];

  let best = preferred;
  let bestRatio = contrastRatio(preferred, background);

  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }

  return best;
}

// ── Legible type ─────────────────────────────────────────────────────────────

/**
 * The smallest a slide may set each role, in points.
 *
 * The StyleSpec's type sizes come from a vision model looking at a reference
 * image, and a reference image is a *picture* — a screenshot at some arbitrary
 * scale, a photograph of a printed page, an export at half size. The model
 * reports what it sees in that picture's own terms, so a perfectly sensible
 * reading of a small screenshot lands body copy at 12pt.
 *
 * On a 13.333in slide 12pt is about the size of a footnote in a paperback,
 * projected across a room. Nothing downstream catches it: the box is in
 * bounds, the contrast is fine, the words fit easily — and the slide is
 * unreadable from the third row.
 *
 * These are the conventional presentation minimums, and they are absolute
 * rather than a fraction of the canvas because the constraint is a human eye
 * at the back of a room, which does not care about the aspect ratio. A deck
 * whose reference image genuinely wants larger type still gets it; the floor
 * only lifts the ones that would arrive too small to read.
 *
 * This floor is also the hard lower bound `browser-layout.ts`'s in-page
 * shrink-to-fit loop is told never to cross — the same rule, now enforced
 * against a real measured render instead of an estimate.
 */
export const MIN_TYPE_SIZES = {
  title: 30,
  subtitle: 20,
  body: 18,
  caption: 14,
} as const;

/**
 * The largest, too — a title is a heading, not a billboard.
 *
 * Expressed as a fraction of the canvas height, because this end of the scale
 * IS about the slide: type taller than a sixth of the slide leaves no room for
 * anything under it, and the same analyzer that reads a small screenshot too
 * small reads a cropped close-up far too large.
 */
const MAX_TITLE_FRACTION = 1 / 6;

/** PptxGenJS wants colours without the leading `#`. */
export function stripHash(hex: string): string {
  return hex.replace(/^#/, '');
}

/**
 * Lifts type to the readable minimum, preserving the design's own hierarchy.
 *
 * The sizes are scaled together rather than clamped individually. Clamping
 * body from 12 to 18 while leaving the title at 72 turns a 6:1 hierarchy into
 * 4:1 — a different design from the one the reference image described. Lifting
 * everything by the same factor keeps the proportions the analyzer actually
 * saw and only changes the scale, which is the thing that was wrong.
 *
 * The title ceiling is applied after, and on its own: a title that overshoots
 * is a title, not a broken hierarchy.
 */
function legibleSizes(
  sizes: { title: number; subtitle: number; body: number; caption: number },
  slideHeightInches: number,
): { title: number; subtitle: number; body: number; caption: number } {
  const lift = Math.max(
    1,
    MIN_TYPE_SIZES.title / sizes.title,
    MIN_TYPE_SIZES.subtitle / sizes.subtitle,
    MIN_TYPE_SIZES.body / sizes.body,
    MIN_TYPE_SIZES.caption / sizes.caption,
  );

  const scaled = {
    title: sizes.title * lift,
    subtitle: sizes.subtitle * lift,
    body: sizes.body * lift,
    caption: sizes.caption * lift,
  };

  // A title taller than a sixth of the slide leaves nothing room to sit under.
  const titleCeiling = slideHeightInches * MAX_TITLE_FRACTION * 72;

  return {
    title: Math.round(Math.min(scaled.title, titleCeiling)),
    subtitle: Math.round(scaled.subtitle),
    body: Math.round(scaled.body),
    caption: Math.round(scaled.caption),
  };
}

export function themeFromStyleSpec(spec: StyleSpec): PPTXTheme {
  const { colors, typography, spacing } = spec;

  return {
    fonts: {
      heading: typography.headingFont,
      body: typography.bodyFont,
      headingFallbacks: typography.headingFontFallbacks,
      bodyFallbacks: typography.bodyFontFallbacks,
    },
    colors: {
      background: colors.background,
      text: colors.primaryText,
      // Fall back within the palette we were given, never to an invented colour.
      secondaryText: colors.secondaryText ?? colors.primaryText,
      accent: colors.accent ?? colors.primaryText,
      surface: colors.surface ?? colors.background,
      border: colors.border ?? colors.primaryText,
    },
    sizes: legibleSizes(
      {
        title: typography.title.size,
        subtitle: typography.subtitle?.size ?? typography.body.size * 1.25,
        body: typography.body.size,
        caption: typography.caption?.size ?? typography.body.size * 0.8,
      },
      spec.slideSize.height,
    ),
    spacing,
  };
}
