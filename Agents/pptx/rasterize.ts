import 'server-only';

import { readFile } from 'node:fs/promises';

import type { Font } from 'fontkit';
import sharp from 'sharp';

import type { SlideElement, SlideSpec, StyleSpec } from '../types';
import { placementFor } from './theme';
import {
  MIN_BACKDROP_DIM,
  TEXT_SCRIM_OPACITY,
  readableOn,
  themeFromStyleSpec,
  type PPTXTheme,
} from './theme-resolve';
import { loadFont, wrapLines, widthInInches } from './text-metrics';

/**
 * Draws a slide as a picture, so a vision model can look at it.
 *
 * Every check in this pipeline until now has been on the *spec*: is the box in
 * bounds, do two boxes overlap, does the text fit the height we computed. None
 * of them can see the slide. They cannot tell you that the title sits on the
 * subject's face, that three cards have wildly different amounts of white
 * space, or that the deck simply looks wrong — and those are the failures a
 * person notices first.
 *
 * ## Why not a headless browser
 *
 * The obvious way to rasterise is to render `SlideCanvas` in Chrome and
 * screenshot it. That is ~150MB of dependency and a browser launch per build,
 * for a picture whose only consumer is a model being asked "does this look
 * right".
 *
 * The cheaper route is exact enough: `fontkit` already loads the deck's real
 * .ttf for measuring, and it exposes glyph outlines. So text is drawn as the
 * actual letterforms of the actual typeface — Playfair Display renders as
 * Playfair Display, with no font installed on the machine — laid out with the
 * same wrapping the renderers use. Boxes, cards, images and scrims follow the
 * same rules as the builder because they are read from the same module.
 *
 * It is a rendering for judgement, not a deliverable. The .pptx remains the
 * artefact; this is the thing that gets looked at before the .pptx is trusted.
 */

/** 96dpi. Enough for a vision model to read body copy, small enough to send. */
const PIXELS_PER_INCH = 96;

/** XML-escapes text destined for an SVG attribute or node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One line of text as SVG paths, positioned at a baseline.
 *
 * Glyph outlines rather than a `<text>` element: `<text>` would need the font
 * installed on the machine, and would silently substitute something else when
 * it is not — which would make the picture lie about the very thing the check
 * is for.
 */
function textToPaths(
  font: Font,
  text: string,
  xInches: number,
  baselineInches: number,
  sizePt: number,
  color: string,
): string {
  const run = font.layout(text);
  const scale = sizePt / 72 / font.unitsPerEm;

  let cursor = xInches * PIXELS_PER_INCH;
  const baseline = baselineInches * PIXELS_PER_INCH;
  const parts: string[] = [];

  run.glyphs.forEach((glyph, index) => {
    const path = glyph.path.toSVG();

    if (path) {
      // The glyph's own units, scaled to pixels and flipped: font space runs
      // up from the baseline, SVG space runs down from the top.
      const k = scale * PIXELS_PER_INCH;
      parts.push(
        `<path d="${path}" fill="${color}" transform="translate(${cursor.toFixed(2)} ${baseline.toFixed(
          2,
        )}) scale(${k.toFixed(6)} ${(-k).toFixed(6)})"/>`,
      );
    }

    cursor += (run.positions[index]?.xAdvance ?? 0) * scale * PIXELS_PER_INCH;
  });

  return parts.join('');
}

/** An element's words, as the renderers would draw them. */
function linesOf(element: SlideElement): string[] {
  if (element.items?.length) return element.items;
  return element.text ? [element.text] : [];
}

function sizeForRole(theme: PPTXTheme, role: string): number {
  switch (role) {
    case 'title':
      return theme.sizes.title;
    case 'subtitle':
      return theme.sizes.subtitle;
    case 'caption':
    case 'label':
      return theme.sizes.caption;
    default:
      return theme.sizes.body;
  }
}

function colorForRole(theme: PPTXTheme, role: string): string {
  if (role === 'caption' || role === 'label') return theme.colors.secondaryText;
  if (role === 'accent') return theme.colors.accent;
  return theme.colors.text;
}

/** Images are embedded so the SVG is self-contained. */
async function dataUri(imagePath: string): Promise<string | null> {
  try {
    const png = await sharp(await readFile(imagePath)).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

export interface RasterisedSlide {
  slideNumber: number;
  png: Buffer;
}

/**
 * Renders each slide to a PNG.
 *
 * Fails soft: a slide that cannot be drawn is omitted rather than throwing. A
 * visual check that cannot run should cost the check, never the deck.
 */
export async function rasterizeSlides(
  slideSpecs: SlideSpec[],
  styleSpec: StyleSpec,
): Promise<RasterisedSlide[]> {
  const theme = themeFromStyleSpec(styleSpec);

  const [headingFont, bodyFont] = await Promise.all([
    loadFont(theme.fonts.heading, styleSpec.typography.title.weight),
    loadFont(theme.fonts.body, styleSpec.typography.body.weight),
  ]);

  if (!headingFont && !bodyFont) return [];

  const width = Math.round(styleSpec.slideSize.width * PIXELS_PER_INCH);
  const height = Math.round(styleSpec.slideSize.height * PIXELS_PER_INCH);
  const rendered: RasterisedSlide[] = [];

  for (const slide of slideSpecs) {
    try {
      const svg = await slideToSvg(slide, theme, {
        heading: headingFont,
        body: bodyFont,
        width,
        height,
      });

      rendered.push({
        slideNumber: slide.slideNumber,
        png: await sharp(Buffer.from(svg)).png().toBuffer(),
      });
    } catch {
      /* one slide that would not draw is not worth failing the check over */
    }
  }

  return rendered;
}

async function slideToSvg(
  slide: SlideSpec,
  theme: PPTXTheme,
  ctx: { heading: Font | null; body: Font | null; width: number; height: number },
): Promise<string> {
  const px = (inches: number) => (inches * PIXELS_PER_INCH).toFixed(2);
  const layers: string[] = [
    `<rect width="${ctx.width}" height="${ctx.height}" fill="${theme.colors.background}"/>`,
  ];

  // A generated backdrop, with the scrim over it — same floor as everywhere.
  if (slide.background?.imagePath) {
    const uri = await dataUri(slide.background.imagePath);
    if (uri) {
      const dim = Math.max(slide.background.dim, MIN_BACKDROP_DIM);
      layers.push(
        `<image href="${uri}" x="0" y="0" width="${ctx.width}" height="${ctx.height}" preserveAspectRatio="xMidYMid slice"/>`,
        `<rect width="${ctx.width}" height="${ctx.height}" fill="${theme.colors.background}" opacity="${dim}"/>`,
      );
    }
  }

  // Pictures, then containers, then text — the builder's own order.
  const ordered = [...slide.elements].sort((a, b) => layer(a) - layer(b));

  for (const element of ordered) {
    const { box } = element;

    if (element.type === 'image') {
      if (!element.imagePath) continue;
      const uri = await dataUri(element.imagePath);
      if (uri) {
        layers.push(
          `<image href="${uri}" x="${px(box.x)}" y="${px(box.y)}" width="${px(box.w)}" height="${px(
            box.h,
          )}" preserveAspectRatio="xMidYMid slice"/>`,
        );
      }
      continue;
    }

    if (element.type === 'divider') {
      layers.push(
        `<line x1="${px(box.x)}" y1="${px(box.y)}" x2="${px(box.x + box.w)}" y2="${px(
          box.y,
        )}" stroke="${theme.colors.border}" stroke-width="1"/>`,
      );
      continue;
    }

    const isCard = element.type === 'card' || element.type === 'shape';
    if (isCard) {
      layers.push(
        `<rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.w)}" height="${px(
          box.h,
        )}" rx="8" fill="${theme.colors.surface}" stroke="${theme.colors.border}" stroke-width="1"/>`,
      );
    }

    const lines = linesOf(element);
    if (lines.length === 0) continue;

    // Text over a picture gets the same panel the builder lays down.
    const overPicture = slide.elements.some(
      (other) =>
        other !== element &&
        other.type === 'image' &&
        other.box.x < box.x + box.w &&
        box.x < other.box.x + other.box.w &&
        other.box.y < box.y + box.h &&
        box.y < other.box.y + other.box.h,
    );

    if (overPicture) {
      layers.push(
        `<rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.w)}" height="${px(
          box.h,
        )}" rx="6" fill="${theme.colors.background}" opacity="${TEXT_SCRIM_OPACITY}"/>`,
      );
    }

    const isHeading = element.role === 'title' || element.role === 'subtitle';
    const font = (isHeading ? ctx.heading : ctx.body) ?? ctx.heading ?? ctx.body;
    if (!font) continue;

    const size = element.fontSize ?? sizeForRole(theme, element.role);
    const behind = isCard
      ? theme.colors.surface
      : overPicture || slide.background?.imagePath
        ? theme.colors.background
        : theme.colors.background;
    const color = readableOn(colorForRole(theme, element.role), behind, theme);

    const fallback = placementFor(element.type, element.role, {
      text: element.text,
      items: element.items,
    });
    const align = element.align ?? fallback.align;
    const valign = element.valign ?? fallback.valign;

    const inset = isCard ? 0.08 : 0;
    const innerX = box.x + inset;
    const innerW = box.w - inset * 2;
    const lineHeight = (size * 1.25) / 72;

    // Bullets when there is more than one item, matching both renderers.
    const bulleted = (element.items?.length ?? 0) > 1;
    const bulletIndent = bulleted ? 0.16 : 0;

    const wrapped = lines.flatMap((line) =>
      wrapLines(font, line, innerW - bulletIndent, size).map((text, index) => ({
        text,
        first: index === 0,
      })),
    );

    const blockHeight = wrapped.length * lineHeight;
    const top =
      valign === 'middle'
        ? box.y + (box.h - blockHeight) / 2
        : valign === 'bottom'
          ? box.y + box.h - blockHeight
          : box.y + inset;

    wrapped.forEach((line, index) => {
      // The baseline sits a little under the line's top edge.
      const baseline = top + index * lineHeight + (size * 0.95) / 72;
      const textWidth = widthInInches(font, line.text, size);

      const x =
        align === 'center'
          ? innerX + (innerW - textWidth) / 2
          : align === 'right'
            ? innerX + innerW - textWidth
            : innerX + bulletIndent;

      if (bulleted && line.first) {
        layers.push(
          `<circle cx="${px(innerX + 0.06)}" cy="${px(baseline - (size * 0.3) / 72)}" r="2" fill="${color}"/>`,
        );
      }

      layers.push(textToPaths(font, line.text, x, baseline, size, color));
    });
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ctx.width}" height="${ctx.height}" viewBox="0 0 ${ctx.width} ${ctx.height}">`,
    `<title>${escapeXml(slide.title ?? `Slide ${slide.slideNumber}`)}</title>`,
    ...layers,
    '</svg>',
  ].join('');
}

/** Pictures, then containers, then text. Mirrors `layer` in the builder. */
function layer(element: SlideElement): number {
  if (element.type === 'image') return 0;
  if (element.type === 'card' || element.type === 'shape') return 1;
  return 2;
}

/**
 * Every slide on one sheet, for a single look.
 *
 * A vision model given twelve separate images reviews twelve slides; given one
 * contact sheet it can also see that slide 7 does not belong with the rest,
 * which is the failure that matters most and the one no per-slide check finds.
 */
export async function contactSheet(
  slides: RasterisedSlide[],
  columns = 3,
): Promise<Buffer | null> {
  if (slides.length === 0) return null;

  const first = await sharp(slides[0].png).metadata();
  if (!first.width || !first.height) return null;

  // Scaled down: legibility of body copy matters less on the sheet than being
  // able to see the whole deck at once, and the per-slide images carry detail.
  const cellWidth = Math.round(first.width / 2);
  const cellHeight = Math.round((first.height / first.width) * cellWidth);
  const gap = 12;
  const rows = Math.ceil(slides.length / columns);

  const cells = await Promise.all(
    slides.map(async (slide, index) => ({
      input: await sharp(slide.png).resize(cellWidth, cellHeight).png().toBuffer(),
      left: gap + (index % columns) * (cellWidth + gap),
      top: gap + Math.floor(index / columns) * (cellHeight + gap),
    })),
  );

  return sharp({
    create: {
      width: gap + columns * (cellWidth + gap),
      height: gap + rows * (cellHeight + gap),
      channels: 3,
      background: '#e9edf2',
    },
  })
    .composite(cells)
    .png()
    .toBuffer();
}
