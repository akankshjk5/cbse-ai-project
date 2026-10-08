import 'server-only';

import * as fontkit from 'fontkit';

/**
 * Real text measurement, from the real font file.
 *
 * ## Why
 *
 * Everything else in this pipeline can be computed exactly. Text could not:
 * with no font loaded, "how many lines is this heading?" was answered by
 * multiplying the character count by a constant, and a constant is wrong in
 * both directions at once. Measured against Playfair Display Bold,
 * "Algorithms Around You" averages 0.514em per character; "THE MUGHAL EMPIRE"
 * is far wider. One number cannot serve both, and being wrong by 5% is the
 * difference between a heading on one line and a heading whose last word is
 * clipped — which is precisely the bug that kept coming back.
 *
 * So the font is fetched and the glyphs are measured. `fontkit` is the same
 * library pdfkit uses; Google Fonts serves a real `.ttf` to any client that
 * does not advertise woff2 support, and the deck already knows which family
 * and weight it settled on because `font-curator` verified them.
 *
 * ## The alternative, and why not
 *
 * The other way to get exact metrics is a headless browser: render the slide,
 * read `getBoundingClientRect()`. It is more faithful still — it would catch
 * kerning, ligatures and CSS line-breaking rules this does not. It also costs
 * a ~150MB dependency and a browser launch per build, and the npm packages
 * that claim to convert HTML straight to .pptx are all hobby-scale (a few
 * hundred downloads a month) and produce slides of flattened images rather
 * than editable shapes. Measuring the font is 1MB and gets the part that
 * actually mattered.
 *
 * Everything here fails soft. A font that will not download leaves the caller
 * to fall back on the estimate in ./theme, which is worse but is not broken.
 */

/** Per-process cache: a deck reuses two families for every slide it has. */
const fonts = new Map<string, fontkit.Font | null>();

/** Long enough for a cold CDN, short enough not to stall a build. */
const FETCH_TIMEOUT_MS = 8000;

function cacheKey(family: string, weight: number): string {
  return `${family.toLowerCase()}@${weight}`;
}

/**
 * The .ttf URL Google Fonts serves for a family and weight.
 *
 * The User-Agent is the whole trick: `css2` returns woff2 to a modern browser
 * and plain TrueType to anything that looks old, and fontkit reads TrueType.
 */
async function ttfUrlFor(family: string, weight: number): Promise<string | null> {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  ).replace(/%20/g, '+')}:wght@${weight}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/4.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const css = await response.text();
  return /src:\s*url\(([^)]+)\)\s*format\('truetype'\)/.exec(css)?.[1] ?? null;
}

/**
 * Loads a Google Font for measuring, or null if it cannot be had.
 *
 * Null is a normal outcome — the machine may be offline, or the family may be
 * a system fallback like Arial that Google does not host — so callers degrade
 * to the estimate rather than treating it as a failure.
 */
export async function loadFont(family: string, weight = 400): Promise<fontkit.Font | null> {
  const key = cacheKey(family, weight);
  const cached = fonts.get(key);
  if (cached !== undefined) return cached;

  let font: fontkit.Font | null = null;

  try {
    const url = await ttfUrlFor(family, weight);
    if (url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) {
        const parsed = fontkit.create(Buffer.from(await response.arrayBuffer()));
        // A .ttc collection has no glyphs of its own; only a single font does.
        font = 'layout' in parsed ? (parsed as fontkit.Font) : null;
      }
    }
  } catch {
    // Offline, timed out, or not a font. The caller falls back.
    font = null;
  }

  fonts.set(key, font);
  return font;
}

/** Width of `text` in ems, from the font's own glyph advances. */
export function widthInEm(font: fontkit.Font, text: string): number {
  if (!text) return 0;
  return font.layout(text).advanceWidth / font.unitsPerEm;
}

/** Width of `text` in inches at `fontSizePt`. */
export function widthInInches(font: fontkit.Font, text: string, fontSizePt: number): number {
  return (widthInEm(font, text) * fontSizePt) / 72;
}

/**
 * Breaks `text` into the lines it will actually occupy.
 *
 * Greedy word wrapping, which is what every renderer here does — PowerPoint,
 * the browser, and pptxgenjs all break at the last space that fits. A single
 * word too long for the line gets a line of its own and overhangs, again
 * matching what the renderers do rather than inventing a hyphenation rule
 * none of them would apply.
 */
export function wrapLines(
  font: fontkit.Font,
  text: string,
  widthInchesAvailable: number,
  fontSizePt: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (current && widthInInches(font, candidate, fontSizePt) > widthInchesAvailable) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/** Lines `text` needs in a box of `widthInches` at `fontSizePt`. */
export function countLines(
  font: fontkit.Font,
  text: string,
  widthInches: number,
  fontSizePt: number,
): number {
  return wrapLines(font, text, widthInches, fontSizePt).length;
}

/** Height `text` needs, in inches, at `fontSizePt` with the renderers' 1.25 leading. */
export function measuredHeight(
  font: fontkit.Font,
  text: string,
  widthInches: number,
  fontSizePt: number,
): number {
  return (countLines(font, text, widthInches, fontSizePt) * fontSizePt * 1.25) / 72;
}

/** Type is never shrunk below this fraction of its intended size. */
const MIN_SCALE = 0.62;

/**
 * The largest size at or below `intendedPt` at which `lines` fit `box`.
 *
 * Searched a point at a time rather than solved, because line count is a step
 * function of size — a closed-form ratio lands between two steps and returns a
 * size that still overflows.
 *
 * Returns `intendedPt` unchanged when the text already fits, so a slide whose
 * copy was written to its budget is never quietly shrunk.
 */
export function fitFontSize(
  font: fontkit.Font,
  lines: string[],
  box: { w: number; h: number },
  intendedPt: number,
): number {
  const floor = Math.max(1, Math.floor(intendedPt * MIN_SCALE));

  for (let size = Math.round(intendedPt); size >= floor; size -= 1) {
    const total = lines.reduce(
      (rows, line) => rows + countLines(font, line, box.w, size),
      0,
    );

    if ((total * size * 1.25) / 72 <= box.h) return size;
  }

  return floor;
}

/**
 * Unicode math/chemistry notation, mapped to a plain-character fallback.
 *
 * Only characters a deck's designer or researcher would plausibly write in
 * an equation or formula — subscript and superscript digits and signs, and
 * the operators chemistry and algebra actually use. `sanitizeMathText` only
 * ever substitutes from this table, on a font that has already been asked
 * for the real glyph and does not have it — an arbitrary missing glyph (an
 * emoji, a script this font never claimed to support) is left exactly as
 * written, because there is no safe fallback to reach for.
 */
const MATH_FALLBACKS: Record<string, string> = {
  // Subscript digits and signs — U+2080-208E.
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  // Superscript digits and signs — U+2070-2079, U+00B2/00B3/00B9, U+207A-207E.
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
  // Operators and symbols common in chemical and mathematical notation.
  '→': '->', '←': '<-', '↔': '<->', '⇌': '<->',
  '×': 'x', '÷': '/', '±': '+/-', '·': '.',
  '≈': '~', '≠': '!=', '≤': '<=', '≥': '>=',
  '√': 'sqrt', '∞': 'infinity', 'Δ': 'Delta', 'π': 'pi',
  '′': "'", '″': '"',
};

/**
 * Replaces a character with its plain-text equivalent, but only where the
 * font actually assigned to this text cannot draw the real one.
 *
 * A chemical equation or an algebraic expression is exactly the kind of copy
 * a slide-designer writes in real Unicode — `CO₂`, `x²`, `A → B` — and most
 * Google Fonts, especially display and serif families chosen for their
 * heading, were never drawn with those code points in mind. Left alone, the
 * glyph that ships is `.notdef`: a visible box where a subscript digit or an
 * arrow should be, in the exact spot the slide is trying hardest to be
 * precise. Checked per character against the font that will actually draw
 * it, this degrades only where it has to — a deck whose body font happens to
 * cover the full range keeps its real subscripts and superscripts.
 */
export function sanitizeMathText(font: fontkit.Font, text: string): string {
  if (!text) return text;

  let changed = false;
  const characters = Array.from(text).map((character) => {
    const fallback = MATH_FALLBACKS[character];
    if (fallback === undefined) return character;
    if (font.glyphForCodePoint(character.codePointAt(0) ?? 0).id !== 0) return character;

    changed = true;
    return fallback;
  });

  return changed ? characters.join('') : text;
}
