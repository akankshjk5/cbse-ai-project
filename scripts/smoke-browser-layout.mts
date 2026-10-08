/**
 * Phase 1 check for the browser-layout migration — see the plan at
 * C:\Users\shree\.claude\plans\crystalline-churning-breeze.md.
 *
 * Runs `Agents/pptx/browser-layout.ts::layoutSlidesInBrowser` against the same
 * fixture decks `smoke:render` uses (a display heading too wide for its box,
 * cards whose content is in `items`, a caption in a tight band), diffs the
 * browser-measured boxes/fontSizes against what the CODE-computed path
 * (`slotsFor` + `fitFontSize`) currently produces for the same specs, and
 * builds a real .pptx from the browser-measured output so it can be opened
 * and checked by eye.
 *
 * Additive only: does not touch `Agents/manager.ts` or delete anything.
 * Needs no API key. Launches a real headless Chromium, so it is slower than
 * `smoke:render` and not part of the default `smoke` suite yet.
 *
 *   npx tsx --require ./scripts/allow-server-only.cjs scripts/smoke-browser-layout.mts
 */

import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { slotsFor } from '../Agents/pptx/layouts.ts';
import { fitFontSize, loadFont } from '../Agents/pptx/text-metrics.ts';
import { themeFromStyleSpec } from '../Agents/pptx/theme-resolve.ts';
import {
  closeBrowserLayoutEngine,
  layoutSlidesInBrowser,
} from '../Agents/pptx/browser-layout.ts';
import { createPptx } from '../Agents/tools/create-pptx.ts';
import { validatePptx } from '../Agents/tools/validate-pptx.ts';
import { styleSpecSchema, type SlideSpec } from '../Agents/types.ts';

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
const hero = slotsFor('title-hero', styleSpec);
const three = slotsFor('three-column', styleSpec);

const slides: SlideSpec[] = [
  {
    slideNumber: 1,
    layout: 'title',
    archetype: 'title-hero',
    title: 'Algorithms Around You',
    elements: [
      // The case that used to lose its last word: a long display heading in
      // a box that only fits it once the real font is actually measured.
      { type: 'text', role: 'title', slot: 'title', box: hero.title!, text: 'Algorithms Around You' },
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
      { type: 'text', role: 'title', slot: 'title', box: three.title!, text: 'You already use them' },
      // Cards carrying `items` only — the case that used to render blank.
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
];

// ── The CODE-computed baseline, exactly as manager.ts's old path runs it ────

const [headingFont, bodyFont] = await Promise.all([
  loadFont(theme.fonts.heading, styleSpec.typography.title.weight),
  loadFont(theme.fonts.body, styleSpec.typography.body.weight),
]);

const codePath: SlideSpec[] = slides.map((slide) => ({
  ...slide,
  elements: slide.elements.map((element) => {
    const lines = element.items?.length ? element.items : element.text ? [element.text] : [];
    if (lines.length === 0) return element;

    const isHeading = element.role === 'title' || element.role === 'subtitle';
    const font = (isHeading ? headingFont : bodyFont) ?? headingFont ?? bodyFont;
    if (!font) return element;

    const intended =
      element.role === 'title'
        ? theme.sizes.title
        : element.role === 'subtitle'
          ? theme.sizes.subtitle
          : element.role === 'caption'
            ? theme.sizes.caption
            : theme.sizes.body;

    const inset = element.type === 'card' ? 0.17 : 0;
    const size = fitFontSize(
      font,
      lines,
      { w: element.box.w - inset * 2, h: element.box.h - inset * 2 },
      intended,
    );
    return { ...element, fontSize: size };
  }),
}));

// ── The BROWSER-measured path, under test ────────────────────────────────

console.log('Rendering fixtures in headless Chromium…');
const browserPath = await layoutSlidesInBrowser(slides, styleSpec);
await closeBrowserLayoutEngine();

// ── Diff ──────────────────────────────────────────────────────────────────

console.log('\nbox/fontSize diffs (code-computed -> browser-measured):');
for (let s = 0; s < slides.length; s += 1) {
  for (let e = 0; e < slides[s].elements.length; e += 1) {
    const before = codePath[s].elements[e];
    const after = browserPath[s].elements[e];
    const boxMoved =
      Math.abs(before.box.x - after.box.x) > 0.05 ||
      Math.abs(before.box.y - after.box.y) > 0.05 ||
      Math.abs(before.box.w - after.box.w) > 0.05 ||
      Math.abs(before.box.h - after.box.h) > 0.05;
    const sizeChanged =
      before.fontSize !== undefined &&
      after.fontSize !== undefined &&
      Math.abs(before.fontSize - after.fontSize) > 1;

    if (boxMoved || sizeChanged) {
      console.log(
        `  slide ${slides[s].slideNumber} ${before.role}: ` +
          `box ${JSON.stringify(before.box)} -> ${JSON.stringify(after.box)}` +
          (sizeChanged ? `, fontSize ${before.fontSize}pt -> ${after.fontSize}pt` : ''),
      );
    }
  }
}

// ── Build a real .pptx from the browser-measured specs, for a by-eye check ──

const built = await createPptx.execute({ styleSpec, slideSpecs: browserPath });
const valid = await validatePptx.execute({
  pptxPath: built.pptxPath,
  expectedSlideCount: built.slideCount,
});
if (!valid.valid) throw new Error(`invalid pptx: ${valid.problems.join(', ')}`);

const dir = await mkdtemp(path.join(tmpdir(), 'lumina-browser-layout-'));
const dump = path.join(dir, 'browser-measured.json');
await writeFile(dump, JSON.stringify(browserPath, null, 2), 'utf8');

console.log(`\npptx:  ${built.pptxPath} (built from browser-measured geometry)`);
console.log(`specs: ${dump}`);
console.log('\nOK');
