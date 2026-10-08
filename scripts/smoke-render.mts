/**
 * Visual check for the rendering pair, with no model calls.
 *
 * Builds a deck from hand-written specs — including the exact cases that have
 * broken before (a display heading too wide for its box, cards whose content
 * is in `items`, a caption in a tight band) — runs the real measuring pass
 * over it, then writes BOTH outputs: the .pptx, and the `SlideCanvas` preview
 * that is supposed to match it. Open the HTML and compare the two.
 *
 * Needs no API key and costs nothing, so it can run on every change to the
 * builder, the canvas, the layouts or the metrics.
 *
 *   npm run smoke:render
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';

import { motionSchema } from '../Agents/motion.ts';
import { slotsFor, stackInSlot } from '../Agents/pptx/layouts.ts';
import { estimateTextHeight } from '../Agents/pptx/theme.ts';
import { themeFromStyleSpec } from '../Agents/pptx/theme-resolve.ts';
import { fitFontSize, loadFont, measuredHeight } from '../Agents/pptx/text-metrics.ts';
import { contactSheet, rasterizeSlides } from '../Agents/pptx/rasterize.ts';
import { createPptx } from '../Agents/tools/create-pptx.ts';
import { validatePptx } from '../Agents/tools/validate-pptx.ts';
import { styleSpecSchema, type SlideSpec } from '../Agents/types.ts';
import { SlideCanvas } from '../src/components/slides/slide-canvas.tsx';
import type { SlideBlock } from '../src/lib/slides/blocks.ts';

const styleSpec = styleSpecSchema.parse({
  version: '1',
  source: { type: 'image', path: 'ref.png' },
  slideSize: { width: 13.333, height: 7.5, aspectRatio: '16:9' },
  colors: {
    background: '#EDEBE0',
    surface: '#FFFFFF',
    primaryText: '#3A3226',
    secondaryText: '#7A6E5D',
    accent: '#B4472E',
    border: '#B4472E',
  },
  typography: {
    headingFont: 'Playfair Display',
    bodyFont: 'Inter',
    headingFontFallbacks: ['Georgia', 'serif'],
    bodyFontFallbacks: ['Helvetica', 'sans-serif'],
    // Deliberately small, as a vision model reading a screenshot reports them.
    // `themeFromStyleSpec` lifts these to the legible floor — the render is
    // where you check that the lift produced a deck you can actually read.
    title: { size: 48, weight: 700 },
    subtitle: { size: 19, weight: 400 },
    body: { size: 11, weight: 400 },
    caption: { size: 8, weight: 400 },
  },
  spacing: { outerMargin: 0.6, sectionGap: 0.35, elementGap: 0.25, paragraphGap: 0.12 },
  visualLanguage: 'warm editorial illustration',
  layoutPrinciples: ['generous whitespace', 'strong type hierarchy'],
});

const theme = themeFromStyleSpec(styleSpec);

// Slots from real archetypes, so the geometry under test is the pipeline's own.
const hero = slotsFor('title-hero', styleSpec);
const three = slotsFor('three-column', styleSpec);
const split = slotsFor('two-column', styleSpec);

const slides: SlideSpec[] = [
  {
    slideNumber: 1,
    layout: 'title',
    archetype: 'title-hero',
    title: 'Algorithms Around You',
    elements: [
      // The case that lost its last word: a long display heading in a box that
      // only fits it once the real font has actually been measured.
      {
        type: 'text',
        role: 'title',
        slot: 'title',
        box: hero.title!,
        text: 'Algorithms Around You',
      },
      {
        type: 'text',
        role: 'subtitle',
        slot: 'subtitle',
        box: hero.subtitle!,
        text: 'Step-by-Step Problem Solving',
      },
      {
        type: 'text',
        role: 'caption',
        slot: 'caption',
        box: hero.caption!,
        text: 'CBSE Class 10 · Computer Science',
      },
    ],
  },
  {
    slideNumber: 2,
    layout: 'three-column',
    archetype: 'three-column',
    title: 'You already use them',
    elements: [
      {
        type: 'text',
        role: 'title',
        slot: 'title',
        box: three.title!,
        text: 'You already use them',
      },
      // Cards carrying `items`, the case that rendered as blank rectangles.
      {
        type: 'card',
        role: 'step-1',
        slot: 'col-1',
        box: three['col-1']!,
        items: ['Following a recipe — the steps run in a fixed order, and each one depends on the last'],
      },
      {
        type: 'card',
        role: 'step-2',
        slot: 'col-2',
        box: three['col-2']!,
        items: ['Tying your shoelaces — the same sequence every time, which is why you stopped thinking about it'],
      },
      {
        type: 'card',
        role: 'step-3',
        slot: 'col-3',
        box: three['col-3']!,
        items: [
          'Turn-by-turn navigation recalculates the whole route whenever you miss a turn',
          'Sorting a playlist compares songs in pairs until the order is settled',
        ],
      },
      {
        type: 'text',
        role: 'caption',
        slot: 'caption',
        box: three.caption!,
        text: 'Order matters — swap the steps and the result changes, just like a recipe.',
      },
    ],
  },
  {
    slideNumber: 3,
    layout: 'two-column',
    archetype: 'two-column',
    title: 'Two Ways to Write One',
    elements: [
      {
        type: 'text',
        role: 'title',
        slot: 'title',
        box: split.title!,
        text: 'Two Ways to Write One',
      },
      {
        type: 'card',
        role: 'comparison-left',
        slot: 'col-1',
        box: split['col-1']!,
        items: [
          'A flowchart draws the logic as shapes — ovals start and end it, rectangles do the work, diamonds ask the questions',
          'Best when the branching matters more than the detail',
        ],
      },
      {
        type: 'card',
        role: 'comparison-right',
        slot: 'col-2',
        box: split['col-2']!,
        items: [
          'Pseudocode writes the logic as plain sentences, close enough to code to translate line by line',
          'Best when the steps matter more than the shape',
        ],
      },
      {
        type: 'text',
        role: 'caption',
        slot: 'caption',
        box: split.caption!,
        text: 'Both make turning the algorithm into code much easier.',
      },
    ],
  },
  // The case from the bug report: the Slide Designer is asked to head each
  // group of bullets with a short label, so a column holds TWO elements with
  // the same `slot`. Both used to be given the slot's whole rectangle and were
  // drawn one on top of the other — the heading and the first bullet sharing a
  // line of pixels. `stackInSlot` divides the slot instead, which is what this
  // slide is here to show.
  (() => {
    const columns = [
      {
        label: 'Data Science',
        items: [
          'Works with tables of numbers rather than pictures or words',
          'Your shopping app recommending products from what you browsed',
        ],
      },
      {
        label: 'Computer Vision',
        items: [
          'Reads images and video the way we read a page',
          'Face filters, Google Lens, and the cameras in a self-driving car',
        ],
      },
      {
        label: 'Natural Language',
        items: [
          'Turns human sentences into something a machine can act on',
          'Understanding reads the meaning; generation writes the reply',
        ],
      },
    ];

    const gap = styleSpec.spacing.elementGap;
    const size = { label: theme.sizes.caption, body: theme.sizes.body };

    return {
      slideNumber: 4,
      layout: 'three-column' as const,
      archetype: 'three-column' as const,
      title: 'Three Domains of AI',
      elements: [
        {
          type: 'text' as const,
          role: 'title',
          slot: 'title' as const,
          box: three.title!,
          text: 'Three Domains of AI',
        },
        ...columns.flatMap((column, index) => {
          const slot = `col-${index + 1}` as 'col-1' | 'col-2' | 'col-3';
          const box = three[slot]!;
          const [labelBox, bodyBox] = stackInSlot(
            box,
            [
              estimateTextHeight(column.label, box.w, size.label),
              column.items.reduce(
                (total, item) => total + estimateTextHeight(item, box.w, size.body),
                0,
              ),
            ],
            gap,
          );

          return [
            { type: 'text' as const, role: 'label', slot, box: labelBox, text: column.label },
            { type: 'text' as const, role: 'body', slot, box: bodyBox, items: column.items },
          ];
        }),
      ],
    };
  })(),
];

// ── The measuring pass, exactly as the Manager runs it ──────────────────────

const [headingFont, bodyFont] = await Promise.all([
  loadFont(theme.fonts.heading, styleSpec.typography.title.weight),
  loadFont(theme.fonts.body, styleSpec.typography.body.weight),
]);

console.log(
  `fonts: ${theme.fonts.heading} ${headingFont ? 'measured' : 'ESTIMATED'} · ` +
    `${theme.fonts.body} ${bodyFont ? 'measured' : 'ESTIMATED'}`,
);

const measured: SlideSpec[] = slides.map((slide) => ({
  ...slide,
  elements: slide.elements.map((element) => {
    const lines = element.items?.length ? element.items : element.text ? [element.text] : [];
    if (lines.length === 0) return element;

    const isHeading = element.role === 'title' || element.role === 'subtitle';
    const font = (isHeading ? headingFont : bodyFont) ?? headingFont ?? bodyFont;
    if (!font) return element;

    // Mirrors `sizeForRole` in the builder and the canvas: a `label` is set at
    // caption size, not body size. Getting that wrong here sizes a box for one
    // scale and measures it at another, and the shrink that follows is the
    // script's mistake rather than the pipeline's.
    const intended =
      element.role === 'title'
        ? theme.sizes.title
        : element.role === 'subtitle'
          ? theme.sizes.subtitle
          : element.role === 'caption' || element.role === 'label'
            ? theme.sizes.caption
            : theme.sizes.body;

    const inset = element.type === 'card' ? 0.17 : 0;
    const size = fitFontSize(
      font,
      lines,
      { w: element.box.w - inset * 2, h: element.box.h - inset * 2 },
      intended,
    );

    if (size < intended) {
      console.log(`  slide ${slide.slideNumber} ${element.role}: ${intended}pt -> ${size}pt`);
    }
    return { ...element, fontSize: size };
  }),
}));

// ── Compaction, as the Manager runs it ──────────────────────────────────────

const compacted: SlideSpec[] = measured.map((slide) => {
  const title = slide.elements.find((e) => e.slot === 'title' && Boolean(e.text));
  if (!headingFont || !title?.text) return slide;

  const size = title.fontSize ?? theme.sizes.title;
  const needed = measuredHeight(headingFont, title.text, title.box.w, size);
  const slack = title.box.h - needed;
  if (slack < 0.3) return slide;

  console.log(`  slide ${slide.slideNumber}: closed a ${slack.toFixed(2)}in title gap`);
  const floor = title.box.y + title.box.h;

  const contentBottom = styleSpec.slideSize.height - styleSpec.spacing.outerMargin;

  // Mirrors `compactTitleBand`: everything below the title moves up by the
  // slack, but only the LOWEST element in each slot grows into it — growing
  // every member of a stack would run each one into the one beneath it.
  const lowest = new Map<string, (typeof slide.elements)[number]>();
  for (const element of slide.elements) {
    if (!element.slot) continue;
    const current = lowest.get(element.slot);
    if (!current || element.box.y > current.box.y) lowest.set(element.slot, element);
  }

  return {
    ...slide,
    elements: slide.elements.map((element) => {
      if (element === title) return { ...element, box: { ...element.box, h: needed } };
      if (!element.slot || element.box.y < floor - 1e-6) return element;
      if (Math.abs(element.box.y + element.box.h - contentBottom) < 1e-6) return element;
      const grows = lowest.get(element.slot) === element;
      return {
        ...element,
        box: {
          ...element.box,
          y: element.box.y - slack,
          h: grows ? element.box.h + slack : element.box.h,
        },
      };
    }),
  };
});

// ── The property the whole exercise is for ─────────────────────────────────
//
// A rendered picture can be looked at; it cannot be asserted on. So the boxes
// the two renderers are about to draw are checked directly: no two text
// elements on a slide may occupy the same pixels, which is the bug this run
// exists to catch. Images are excluded — a caption over a picture is a
// deliberate composition, and both renderers scrim it.
for (const slide of compacted) {
  const drawn = slide.elements.filter((element) => element.type !== 'image');
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i].box;
      const b = drawn[j].box;
      const hit =
        a.x < b.x + b.w - 1e-6 &&
        b.x < a.x + a.w - 1e-6 &&
        a.y < b.y + b.h - 1e-6 &&
        b.y < a.y + a.h - 1e-6;
      if (hit) {
        throw new Error(
          `slide ${slide.slideNumber}: ${drawn[i].role} overlaps ${drawn[j].role} — ` +
            `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
        );
      }
    }
  }
}
console.log(`overlap: ${compacted.length} slides, no two text boxes share a pixel`);

// ── Both outputs, from the same specs ───────────────────────────────────────

const built = await createPptx.execute({ styleSpec, slideSpecs: compacted });
const valid = await validatePptx.execute({
  pptxPath: built.pptxPath,
  expectedSlideCount: built.slideCount,
});
if (!valid.valid) throw new Error(`invalid pptx: ${valid.problems.join(', ')}`);

const toBlocks = (slide: SlideSpec): SlideBlock[] =>
  slide.elements.map((element) => ({
    type: element.type,
    role: element.role,
    box: element.box,
    text: element.text,
    items: element.items,
    imageUrl: null,
    align: element.align,
    valign: element.valign,
    fontSize: element.fontSize,
  }));

const families = [theme.fonts.heading, theme.fonts.body]
  .map((family) => `family=${family.replace(/ /g, '+')}:wght@400;700`)
  .join('&');

const body = compacted
  .map((slide) => {
    const markup = renderToStaticMarkup(
      SlideCanvas({
        slide: {
          title: slide.title ?? null,
          subtitle: slide.subtitle ?? null,
          blocks: toBlocks(slide),
          backgroundUrl: null,
          backgroundDim: 0.55,
        },
        theme,
        slideSize: { width: styleSpec.slideSize.width, height: styleSpec.slideSize.height },
      }),
    );

    return `<figure><figcaption>${slide.slideNumber}. ${slide.archetype}</figcaption>${markup}</figure>`;
  })
  .join('\n');

// ── The same property, on the export path ──────────────────────────────────
//
// `viewportMode: 'export'` positions slotted elements by CSS Grid area rather
// than by box (Agents/pptx/browser-layout.ts measures that render). Two
// children of ONE `grid-area` share a cell — an overlap, not a stack — so a
// shared slot must render as a single flex column that owns the area. Checked
// in the markup because a browser is not needed to see it, and the browser
// engine is behind a flag that this run does not set.
{
  const stacked = compacted.find((slide) => slide.slideNumber === 4)!;
  const markup = renderToStaticMarkup(
    SlideCanvas({
      slide: {
        title: stacked.title ?? null,
        subtitle: stacked.subtitle ?? null,
        blocks: toBlocks(stacked).map((block, index) => ({
          ...block,
          slot: stacked.elements[index].slot,
        })),
        backgroundUrl: null,
        backgroundDim: 0,
        archetype: stacked.archetype ?? null,
      },
      theme,
      slideSize: { width: styleSpec.slideSize.width, height: styleSpec.slideSize.height },
      viewportMode: 'export',
    }),
  );

  for (const slot of ['col-1', 'col-2', 'col-3']) {
    const claims = markup.split(`grid-area:${slot}`).length - 1;
    if (claims !== 1) {
      throw new Error(`export grid: ${claims} elements claim ${slot}; a shared slot must be one column`);
    }
  }
  console.log('export grid: each shared slot renders as one column, not overlapping cells');
}

// ── Motion reaches the live render, and nothing else ───────────────────────
//
// Two properties, both checked in the markup because both are about what is
// EMITTED rather than about how it looks: the live stage carries the element's
// motion as custom properties, and the export render — the one
// `browser-layout.ts` measures — carries none of it. A box caught mid-zoom
// measures as whatever scale it happened to be at, so this is the check that
// keeps an animation from quietly rewriting the geometry.
{
  const first = compacted[0];
  const animated = {
    title: first.title ?? null,
    subtitle: first.subtitle ?? null,
    blocks: toBlocks(first).map((block, index) => ({
      ...block,
      motion: index === 0 ? motionSchema.parse({ effect: 'zoom-in', intensity: 0.4 }) : undefined,
    })),
    backgroundUrl: null,
    backgroundDim: 0,
  };
  const size = { width: styleSpec.slideSize.width, height: styleSpec.slideSize.height };

  const live = renderToStaticMarkup(
    SlideCanvas({ slide: animated, theme, slideSize: size, animate: true }),
  );
  if (!live.includes('data-motion-play="on"') || !live.includes('data-motion="enter"')) {
    throw new Error('motion: the live stage did not emit its entrance');
  }
  if (!live.includes('--lm-to:1') || !live.includes('--lm-from:0.8')) {
    throw new Error('motion: the live stage did not emit the scales motionFrames computed');
  }

  const exported = renderToStaticMarkup(
    SlideCanvas({
      slide: animated,
      theme,
      slideSize: size,
      viewportMode: 'export',
      animate: true,
    }),
  );
  if (exported.includes('data-motion')) {
    throw new Error('motion: the export render must be static, whatever the caller asks for');
  }

  const still = renderToStaticMarkup(SlideCanvas({ slide: animated, theme, slideSize: size }));
  if (still.includes('data-motion')) {
    throw new Error('motion: a thumbnail must not animate');
  }

  console.log('motion: live stage animates, export and thumbnail render static');
}

const dir = await mkdtemp(path.join(tmpdir(), 'lumina-render-'));
const preview = path.join(dir, 'preview.html');

await writeFile(
  preview,
  [
    '<!doctype html><meta charset="utf-8"><title>Render check</title>',
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=swap">`,
    '<style>',
    '  body { margin:0; padding:32px; background:#e9edf2; font:14px system-ui, sans-serif; }',
    '  figure { margin:0 auto 28px; max-width:1100px; }',
    '  figcaption { margin-bottom:6px; color:#475569; font-size:12px; }',
    '  figure > div { box-shadow:0 6px 24px rgba(15,23,42,.18); border-radius:6px; }',
    '</style>',
    body,
  ].join('\n'),
  'utf8',
);

// ── The rendering the visual reviewer sees ─────────────────────────
//
// Drawn from glyph outlines, so the real typeface appears with no font
// installed anywhere. If this sheet is not legible the vision check that
// consumes it is worthless — which is why it is written out to be looked at.
const raster = await rasterizeSlides(compacted, styleSpec);
const sheet = await contactSheet(raster);

let sheetPath: string | null = null;
if (sheet) {
  sheetPath = path.join(dir, 'contact-sheet.png');
  await writeFile(sheetPath, sheet);
}

console.log(`\npptx:    ${built.pptxPath}`);
console.log(`preview: ${preview}`);
console.log(
  sheetPath
    ? `sheet:   ${sheetPath} (${raster.length} slides drawn)`
    : 'sheet:   FAILED - the visual reviewer would have nothing to look at',
);
console.log('\nOK');
