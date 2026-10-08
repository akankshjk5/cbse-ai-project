import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';

import { SlideCanvas, type RenderableSlide } from '@/components/slides/slide-canvas';
import type { SlideBlock } from '@/lib/slides/blocks';
import type { SlideElement, SlideSpec, StyleSpec } from '../types';
import { fontStack, themeFromStyleSpec, type PPTXTheme } from './theme-resolve';

/**
 * MIGRATION PLAN — see C:\Users\shree\.claude\plans\crystalline-churning-breeze.md
 * for the full write-up. Short version, for anyone reading this file cold:
 *
 * lumina-deck-pro used to compute slide geometry (`./layouts.ts`) and text
 * sizing (`./text-metrics.ts`) in code, deliberately avoiding a headless
 * browser — both modules' own docstrings explain why (~150MB dependency, a
 * browser launch per build, for what CSS already does for free). This module
 * reverses that call: it renders the real `SlideCanvas` component — the same
 * one the web app already uses as its live preview — into a headless
 * Chromium via Playwright, lets real CSS Grid/Flexbox and real text wrapping
 * happen, and reads the result back.
 *
 * It is a MEASUREMENT engine, not the deliverable's renderer. The `.pptx`
 * file itself is still produced by `Agents/pptx/builder.ts` (pptxgenjs),
 * completely unchanged — this module's whole job is to write real,
 * browser-measured `box`/`fontSize` values onto each `SlideElement` so that
 * builder.ts's existing "read box/fontSize verbatim, never recompute"
 * contract is satisfied with better numbers than `layouts.ts`/`text-metrics.ts`
 * used to produce. That is what keeps the exported file real editable shapes
 * instead of a flattened screenshot.
 *
 * Gated behind `serverEnv.layoutEngine` (`LAYOUT_ENGINE=browser`) — see
 * `Agents/manager.ts`'s `layoutSlidesInBrowser` call site — until it has run
 * cleanly against real decks. `./layouts.ts`, `./text-metrics.ts` and this
 * file's now-superseded caller in `manager.ts` are only deleted once that
 * flag is the unconditional default (migration Phase 4).
 */

const EXPORT_PIXELS_PER_INCH = 96;

/** One shared Chromium instance per process — a launch per slide would dominate build time. */
let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  const { chromium } = await import('playwright');
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

/** Closes the shared browser. Call once at process/build teardown, not per slide. */
export async function closeBrowserLayoutEngine(): Promise<void> {
  if (!sharedBrowser) return;
  await sharedBrowser.close();
  sharedBrowser = null;
}

/** Reads a local file the pipeline generated and inlines it, so the page needs no HTTP server. */
async function toDataUri(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext || 'png';
    return `data:image/${mime};base64,${buffer.toString('base64')}`;
  } catch {
    // The illustrator already fails soft when an image can't be produced;
    // this mirrors that rather than failing the whole slide's layout pass.
    return null;
  }
}

/**
 * `SlideElement[]` -> the shape `SlideCanvas` actually renders.
 *
 * `SlideCanvas` was built for the web app's persisted shape (`SlideBlock`,
 * `imageUrl`), not the pipeline's in-flight shape (`SlideElement`,
 * `imagePath`, a local file that does not exist yet as far as a browser is
 * concerned). This is the one place that gap is bridged — deliberately thin,
 * so it cannot quietly diverge from what `src/lib/data/generation.ts`'s
 * `toWebBlocks` does for the *persisted* path: same fields, same
 * `imagePath -> image source` idea, only the source is a data: URI here
 * instead of a CDN URL because the file has not been uploaded yet.
 */
async function toRenderableSlide(
  slideSpec: SlideSpec,
  imageUris: Map<string, string>,
): Promise<RenderableSlide> {
  const blocks: SlideBlock[] = slideSpec.elements.map((element: SlideElement) => ({
    type: element.type,
    role: element.role,
    box: element.box,
    text: element.text,
    items: element.items,
    imageUrl: element.imagePath ? (imageUris.get(element.imagePath) ?? null) : null,
    imagePrompt: element.imagePrompt,
    align: element.align,
    valign: element.valign,
    fontSize: undefined, // being measured — never trust a stale value in.
    color: element.color,
    fill: element.fill,
    // Carried through so the export-mode render can route this element into
    // its archetype's CSS Grid area instead of an absolute `box` guess — see
    // `Agents/pptx/archetype-grid.ts`.
    slot: element.slot,
  }));

  const backgroundUrl = slideSpec.background?.imagePath
    ? (imageUris.get(slideSpec.background.imagePath) ?? null)
    : null;

  return {
    title: slideSpec.title ?? null,
    subtitle: slideSpec.subtitle ?? null,
    blocks,
    backgroundUrl,
    backgroundDim: slideSpec.background?.dim ?? 0,
    archetype: slideSpec.archetype ?? null,
  };
}

/** A Google Fonts `<link>` covering both curated families, regular + bold. */
function googleFontsLinkHref(theme: PPTXTheme): string {
  const families = [...new Set([theme.fonts.heading, theme.fonts.body])];
  const query = families
    .map((name) => `family=${encodeURIComponent(name)}:wght@400;700`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=block`;
}

function renderExportHtml(
  renderable: RenderableSlide,
  theme: PPTXTheme,
  slideSize: { width: number; height: number },
): string {
  const markup = renderToStaticMarkup(
    React.createElement(SlideCanvas, {
      slide: renderable,
      theme,
      slideSize,
      viewportMode: 'export',
    }),
  );

  const widthPx = Math.round(slideSize.width * EXPORT_PIXELS_PER_INCH);
  const heightPx = Math.round(slideSize.height * EXPORT_PIXELS_PER_INCH);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${googleFontsLinkHref(theme)}" />
<style>
  html, body { margin: 0; padding: 0; }
  * { box-sizing: border-box; }
  body { font-family: ${fontStack(theme, 'body')}; }
</style>
</head>
<body>
<div id="root" style="position:relative;width:${widthPx}px;height:${heightPx}px;overflow:hidden;">
${markup}
</div>
</body>
</html>`;
}

export interface MeasuredElement {
  box: { x: number; y: number; w: number; h: number };
  fontSize?: number;
}

/**
 * Runs one slide through a headless-browser render, reads back each
 * element's real box (inches) and, for text-bearing elements, a font size
 * that has been shrunk in-page until it actually fits — never below the
 * role's `MIN_TYPE_SIZES` floor.
 *
 * Fails soft per slide: a page crash or a font that never loads returns
 * `null` rather than throwing, so `layoutSlidesInBrowser` can fall back to
 * the slide's last known-good geometry instead of failing the whole deck.
 */
async function measureSlide(
  slideSpec: SlideSpec,
  styleSpec: StyleSpec,
  theme: PPTXTheme,
  imageUris: Map<string, string>,
): Promise<MeasuredElement[] | null> {
  const slideSize = { width: styleSpec.slideSize.width, height: styleSpec.slideSize.height };
  const renderable = await toRenderableSlide(slideSpec, imageUris);
  const html = renderExportHtml(renderable, theme, slideSize);

  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: {
      width: Math.round(slideSize.width * EXPORT_PIXELS_PER_INCH),
      height: Math.round(slideSize.height * EXPORT_PIXELS_PER_INCH),
    },
  });

  try {
    // NOT 'load': that waits on every subresource, including the Google Fonts
    // <link>, and a slow/blocked font fetch would otherwise hang the whole
    // deck's layout pass. 'domcontentloaded' is enough to run the in-page
    // script; the explicit, bounded wait below is what actually waits for
    // fonts, and gives up rather than hanging if they never arrive.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    // Fonts loaded via a Google Fonts <link> race the initial paint; measuring
    // before they resolve reads fallback-font metrics and shrinks against the
    // wrong glyph widths. Bounded because an unreachable Google Fonts CDN
    // (offline, firewalled) must degrade to system-font metrics, not hang the
    // build — the rest of this pipeline already treats an unloadable font as
    // a soft failure (see `loadFont` in ./text-metrics.ts).
    await Promise.race([
      page.evaluate(() => document.fonts.ready),
      page.waitForTimeout(8_000),
    ]);

    const measured = await page.evaluate(() => {
      const results: Record<string, { x: number; y: number; w: number; h: number; fontSize?: number }> = {};
      const root = document.getElementById('root');
      if (!root) return results;
      const rootRect = root.getBoundingClientRect();

      const nodes = root.querySelectorAll<HTMLElement>('[data-element-id]');
      nodes.forEach((node) => {
        const id = node.getAttribute('data-element-id');
        if (id === null) return;

        const minFontPxAttr = node.getAttribute('data-min-font-px');
        if (minFontPxAttr !== null) {
          const floor = Number(minFontPxAttr);
          let size = Number.parseFloat(getComputedStyle(node).fontSize);
          // Binary-search-shaped step-down: mirrors `fitFontSize`'s algorithm
          // (Agents/pptx/text-metrics.ts), now against a real DOM measurement
          // instead of fontkit glyph math.
          let guard = 0;
          while (node.scrollHeight > node.clientHeight + 1 && size > floor && guard < 60) {
            size = Math.max(floor, size - 1);
            node.style.fontSize = `${size}px`;
            guard += 1;
          }
        }

        const rect = node.getBoundingClientRect();
        const fontSizeAttr = getComputedStyle(node).fontSize;
        results[id] = {
          x: rect.left - rootRect.left,
          y: rect.top - rootRect.top,
          w: rect.width,
          h: rect.height,
          fontSize:
            node.getAttribute('data-min-font-px') !== null
              ? Number.parseFloat(fontSizeAttr)
              : undefined,
        };
      });

      return results;
    });

    return slideSpec.elements.map((_, index) => {
      const entry = measured[String(index)];
      if (!entry) {
        // No node rendered for this element (e.g. a dropped image) — leave
        // its existing box/fontSize alone rather than inventing zeros.
        return { box: slideSpec.elements[index].box };
      }
      return {
        box: {
          x: entry.x / EXPORT_PIXELS_PER_INCH,
          y: entry.y / EXPORT_PIXELS_PER_INCH,
          w: entry.w / EXPORT_PIXELS_PER_INCH,
          h: entry.h / EXPORT_PIXELS_PER_INCH,
        },
        fontSize: entry.fontSize ? (entry.fontSize / EXPORT_PIXELS_PER_INCH) * 72 : undefined,
      };
    });
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Replaces `applyLayouts` + `growTextBoxes` + `fitToCanvas` + `fitTypeToBoxes`
 * + `compactTitleBand` in `Agents/manager.ts`'s pipeline with one real-browser
 * pass. Every generated/carried-forward image must already have a resolved
 * local `imagePath` by the time this runs (i.e. call it after `illustrate`/
 * `carryForwardImages`, exactly where the old sequence used to run).
 *
 * Per-slide failures degrade to that slide's incoming geometry rather than
 * aborting the deck, matching the fail-soft convention the rest of this
 * pipeline already follows (`illustrateSlides`, `rasterizeSlides`, `loadFont`).
 */
export async function layoutSlidesInBrowser(
  slideSpecs: SlideSpec[],
  styleSpec: StyleSpec,
): Promise<SlideSpec[]> {
  const theme = themeFromStyleSpec(styleSpec);

  const imagePaths = new Set<string>();
  for (const spec of slideSpecs) {
    if (spec.background?.imagePath) imagePaths.add(spec.background.imagePath);
    for (const element of spec.elements) {
      if (element.imagePath) imagePaths.add(element.imagePath);
    }
  }
  const imageUris = new Map<string, string>();
  await Promise.all(
    [...imagePaths].map(async (filePath) => {
      const uri = await toDataUri(filePath);
      if (uri) imageUris.set(filePath, uri);
    }),
  );

  return Promise.all(
    slideSpecs.map(async (slideSpec) => {
      const measured = await measureSlide(slideSpec, styleSpec, theme, imageUris);
      if (!measured) return slideSpec;

      return {
        ...slideSpec,
        elements: slideSpec.elements.map((element, index) => ({
          ...element,
          box: measured[index]?.box ?? element.box,
          fontSize: measured[index]?.fontSize ?? element.fontSize,
        })),
      };
    }),
  );
}
