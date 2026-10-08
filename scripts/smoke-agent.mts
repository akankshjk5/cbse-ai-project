/**
 * Smoke test for the deterministic half of the pipeline: skill parsing, layout
 * checks, PPTX construction and validation. No model calls, so it runs without
 * an API key.
 *
 *   npm run smoke
 */

import { readFile } from 'node:fs/promises';

import JSZip from 'jszip';

import { listSkills } from '../Agents/skill-loader.ts';
import { contains, contentArea, largestFreeRect, overlaps } from '../Agents/pptx/positioning.ts';
import {
  ARCHETYPE_GUIDE,
  LAYOUT_ARCHETYPES,
  slotsFor,
  stackInSlot,
} from '../Agents/pptx/layouts.ts';
import {
  countLines,
  fitFontSize,
  loadFont,
  widthInEm,
  wrapLines,
} from '../Agents/pptx/text-metrics.ts';
import {
  estimateLines,
  estimateTextHeight,
  placementFor,
  shrinkToFit,
} from '../Agents/pptx/theme.ts';
import {
  MIN_CONTRAST,
  MIN_TYPE_SIZES,
  contrastRatio,
  readableOn,
  themeFromStyleSpec,
} from '../Agents/pptx/theme-resolve.ts';
import { checkOverflow } from '../Agents/tools/check-overflow.ts';
import { checkWordBudget } from '../Agents/tools/check-word-budget.ts';
import { buildImagePrompt, styleEnvelope } from '../Agents/image-prompt.ts';
import {
  MAX_ZOOM_DELTA,
  defaultMotionFor,
  motionFrames,
  motionSchema,
} from '../Agents/motion.ts';
import { createPptx } from '../Agents/tools/create-pptx.ts';
import { validatePptx } from '../Agents/tools/validate-pptx.ts';
import { styleSpecSchema, type SlideSpec } from '../Agents/types.ts';
import { DECK_TEMPLATES, TEMPLATE_IDS, templateStyleSpec } from '../src/lib/templates.ts';

const skills = await listSkills();
console.log(`skills: ${skills.length}`);
for (const s of skills) {
  console.log(`  ${s.name}: ${s.tools.length} tools, prompt ${s.systemPrompt.length} chars`);
  if (!s.tools.some((t) => t.name === 'reset_to_manager')) {
    throw new Error(`${s.name} is missing reset_to_manager`);
  }
}

const styleSpec = styleSpecSchema.parse({
  version: '1',
  source: { type: 'image', path: 'ref.png' },
  slideSize: { width: 13.333, height: 7.5, aspectRatio: '16:9' },
  colors: { background: '#0B1B2B', primaryText: '#FFFFFF', accent: '#F2A65A' },
  typography: {
    headingFont: 'Georgia',
    bodyFont: 'Arial',
    title: { size: 40, weight: 700 },
    body: { size: 18, weight: 400 },
  },
  spacing: { outerMargin: 0.6, sectionGap: 0.4, elementGap: 0.3, paragraphGap: 0.15 },
  visualLanguage: 'editorial',
  layoutPrinciples: ['generous whitespace', 'strong type hierarchy'],
});

const slides: SlideSpec[] = [
  {
    slideNumber: 1,
    layout: 'title',
    elements: [
      { type: 'text', role: 'title', box: { x: 0.6, y: 2.6, w: 12, h: 1.4 }, text: 'Photosynthesis' },
      { type: 'text', role: 'subtitle', box: { x: 0.6, y: 4.1, w: 12, h: 0.8 }, text: 'Class 8 Science' },
    ],
  },
  {
    slideNumber: 3,
    layout: 'three-column',
    title: 'Cards carry items too',
    elements: [
      { type: 'text', role: 'title', box: { x: 0.6, y: 0.6, w: 12, h: 1 }, text: 'Cards carry items too' },
      // The shape that used to render as an empty white rectangle: a card
      // whose words are in `items` rather than `text`.
      {
        type: 'card',
        role: 'step-1',
        box: { x: 0.6, y: 2, w: 3.8, h: 1.8 },
        items: ['Read the recipe end to end'],
      },
      {
        type: 'card',
        role: 'step-2',
        box: { x: 4.8, y: 2, w: 3.8, h: 1.8 },
        items: ['Measure every ingredient', 'Preheat the oven'],
      },
    ],
  },
  {
    slideNumber: 2,
    layout: 'single-column',
    elements: [
      { type: 'text', role: 'title', box: { x: 0.6, y: 0.6, w: 12, h: 1 }, text: 'How it works' },
      {
        type: 'text',
        role: 'body',
        box: { x: 0.6, y: 1.9, w: 12, h: 4.5 },
        items: ['Light is absorbed by chlorophyll', 'Water splits into hydrogen and oxygen', 'Glucose is synthesised'],
      },
    ],
  },
];

for (const slideSpec of slides) {
  const r = await checkOverflow.execute({ slideSpec, styleSpec });
  console.log(`overflow slide ${r.slideNumber}: fits=${r.fits} issues=${r.issues.length}`);
}

// ── Legible type ───────────────────────────────────────────────────────────
//
// A reference image is a picture at some arbitrary scale, so the vision model
// reads it in that picture's terms — which is how body copy arrives at 12pt on
// a 13in slide. Nothing else in the pipeline catches it: the box fits, the
// contrast is fine, and the slide is unreadable from the third row.
const tiny = styleSpecSchema.parse({
  ...JSON.parse(JSON.stringify(styleSpec)),
  typography: {
    ...JSON.parse(JSON.stringify(styleSpec.typography)),
    title: { size: 30, weight: 700 },
    subtitle: { size: 10, weight: 400 },
    body: { size: 8, weight: 400 },
    caption: { size: 6, weight: 400 },
  },
});

const lifted = themeFromStyleSpec(tiny).sizes;
for (const [role, floor] of Object.entries(MIN_TYPE_SIZES)) {
  const got = lifted[role as keyof typeof lifted];
  if (got < floor) throw new Error(`${role} came out at ${got}pt, below the ${floor}pt floor`);
}

// The hierarchy the reference described must survive being scaled up: a deck
// whose body was a quarter of its title should still be, or the lift has
// quietly redesigned it.
const before = 8 / 30;
const after = lifted.body / lifted.title;
if (Math.abs(after - before) > 0.05) {
  throw new Error(`type hierarchy drifted: body/title was ${before.toFixed(2)}, now ${after.toFixed(2)}`);
}
console.log(
  `type floor: 8pt body lifted to ${lifted.body}pt, hierarchy preserved (${after.toFixed(2)} vs ${before.toFixed(2)})`,
);

// A deck already legible is left exactly as it was.
const untouched = themeFromStyleSpec(styleSpec).sizes;
if (untouched.body !== styleSpec.typography.body.size) {
  throw new Error('type floor changed a size that was already readable');
}

// ── Real font metrics ──────────────────────────────────────────────────────
//
// The estimate in theme.ts multiplies a character count by a constant, and a
// constant is wrong in both directions depending on the string. This is the
// pass that replaced it. Skipped without a network — Google Fonts is where the
// .ttf comes from — because a smoke test must not fail on an offline machine.
const playfair = await loadFont('Playfair Display', 700);

if (!playfair) {
  console.log('metrics: SKIPPED (could not fetch the font — offline?)');
} else {
  const heading = 'Algorithms Around You';
  const em = widthInEm(playfair, heading) / heading.length;
  console.log(`metrics: "${heading}" measures ${em.toFixed(3)}em/char in Playfair Display Bold`);

  // The bug this pass exists to kill: at 72pt in an 8in box the heading needs
  // two lines, and the old estimate said one.
  const lines = countLines(playfair, heading, 8, 72);
  if (lines < 2) throw new Error(`measured ${lines} line(s) at 72pt in 8in — should not fit`);

  // Shrunk, it must genuinely fit the 1in box the designer gave it.
  const box = { w: 8, h: 1 };
  const size = fitFontSize(playfair, [heading], box, 72);
  const height = (countLines(playfair, heading, box.w, size) * size * 1.25) / 72;
  if (height > box.h) {
    throw new Error(`fitFontSize picked ${size}pt, still ${height.toFixed(2)}in in a ${box.h}in box`);
  }
  console.log(`metrics: 72pt -> ${size}pt fits ${box.h}in (${height.toFixed(2)}in used)`);

  // Wrapping must not lose words — the failure that clipped "You".
  const wrapped = wrapLines(playfair, heading, box.w, size).join(' ');
  if (wrapped !== heading) throw new Error(`wrapLines lost text: "${wrapped}"`);
  console.log('metrics: wrapping preserves every word');
}

// ── Layout archetypes ──────────────────────────────────────────────────────
//
// The reason this module exists is that a model placing its own boxes produces
// overlaps and escapes. Code placing them must not, so every archetype is
// checked: each slot inside the canvas, and no two slots on top of each other.
// A regression here would reintroduce exactly the bug it was built to remove.
for (const archetype of LAYOUT_ARCHETYPES) {
  const slots = slotsFor(archetype, styleSpec);
  const named = Object.entries(slots) as [string, { x: number; y: number; w: number; h: number }][];

  if (named.length === 0) throw new Error(`${archetype} defines no slots`);

  for (const [name, box] of named) {
    if (box.w <= 0 || box.h <= 0) {
      throw new Error(`${archetype}.${name} has no area: ${box.w}x${box.h}`);
    }
    if (
      box.x < -1e-6 ||
      box.y < -1e-6 ||
      box.x + box.w > styleSpec.slideSize.width + 1e-6 ||
      box.y + box.h > styleSpec.slideSize.height + 1e-6
    ) {
      throw new Error(`${archetype}.${name} escapes the slide: ${JSON.stringify(box)}`);
    }
  }

  // `full-bleed` is the deliberate exception: its picture IS the slide, and the
  // text panel sits on top of it. Every other archetype must be disjoint.
  if (archetype !== 'full-bleed') {
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        if (overlaps(named[i][1], named[j][1])) {
          throw new Error(`${archetype}: ${named[i][0]} overlaps ${named[j][0]}`);
        }
      }
    }
  }

  if (!ARCHETYPE_GUIDE[archetype]) throw new Error(`${archetype} has no description for the prompt`);

  // A slot may be claimed by more than one element — the Slide Designer is
  // asked for a sub-heading above each group of bullets, so `col-1` routinely
  // holds a label AND a list. Handing both the slot's rectangle drew them on
  // top of one another, which is the exact failure this module exists to
  // prevent, so the division is checked with the same rigour as the slots.
  for (const [name, slot] of named) {
    for (const shares of [
      [1, 1],
      [0.3, 2.4],
      [4, 0.2],
      [1, 1, 1],
      [0, -3, Number.NaN],
    ]) {
      const stack = stackInSlot(slot, shares, styleSpec.spacing.elementGap);

      if (stack.length !== shares.length) {
        throw new Error(`${archetype}.${name}: stackInSlot returned ${stack.length} of ${shares.length}`);
      }

      for (const [index, box] of stack.entries()) {
        if (box.h <= 0 || box.w <= 0) {
          throw new Error(`${archetype}.${name}[${index}] has no area: ${box.w}x${box.h}`);
        }
        if (
          box.x < slot.x - 1e-6 ||
          box.y < slot.y - 1e-6 ||
          box.x + box.w > slot.x + slot.w + 1e-6 ||
          box.y + box.h > slot.y + slot.h + 1e-6
        ) {
          throw new Error(
            `${archetype}.${name}[${index}] escapes its slot: ${JSON.stringify(box)} vs ${JSON.stringify(slot)}`,
          );
        }
      }

      for (let i = 0; i < stack.length; i++) {
        for (let j = i + 1; j < stack.length; j++) {
          if (overlaps(stack[i], stack[j])) {
            throw new Error(
              `${archetype}.${name}: stacked ${i} overlaps ${j} — ${JSON.stringify(stack)}`,
            );
          }
        }
      }
    }
  }
}
console.log(
  `layouts: ${LAYOUT_ARCHETYPES.length} archetypes, all slots in bounds and disjoint, shared slots stack without overlap`,
);

// ── Free-space search: where an auto-added illustration goes ───────────────
//
// The geometry that decides whether a slide gets a picture or a backdrop, so
// it is worth checking against cases with a known right answer.
const area = contentArea(styleSpec);

const freeCases: { name: string; occupied: { x: number; y: number; w: number; h: number }[] }[] = [
  { name: 'empty slide', occupied: [] },
  {
    name: 'title + left column',
    occupied: [
      { x: 0.6, y: 0.6, w: 12.1, h: 1.0 },
      { x: 0.6, y: 1.9, w: 5.8, h: 4.5 },
    ],
  },
  {
    name: 'full slide',
    occupied: [{ x: 0.6, y: 0.6, w: 12.1, h: 6.3 }],
  },
];

for (const { name, occupied } of freeCases) {
  const free = largestFreeRect(area, occupied, styleSpec.spacing.elementGap);

  if (!free) {
    console.log(`free space (${name}): none`);
    continue;
  }

  // The result must be inside the content area and clear of everything on it.
  const inside =
    free.x >= area.x - 1e-6 &&
    free.y >= area.y - 1e-6 &&
    free.x + free.w <= area.x + area.w + 1e-6 &&
    free.y + free.h <= area.y + area.h + 1e-6;
  if (!inside) throw new Error(`largestFreeRect(${name}) escaped the content area`);

  const clashes = occupied.filter((box) => overlaps(box, free));
  if (clashes.length > 0) throw new Error(`largestFreeRect(${name}) overlaps ${clashes.length} element(s)`);

  console.log(
    `free space (${name}): ${free.w.toFixed(2)}x${free.h.toFixed(2)}in at ${free.x.toFixed(2)},${free.y.toFixed(2)}`,
  );
}

// A slide with room must actually get a picture; a full one must not.
const roomy = largestFreeRect(area, freeCases[1].occupied, styleSpec.spacing.elementGap);
if (!roomy || roomy.w < 1.6 || roomy.h < 1.6) {
  throw new Error('a two-column slide should have room for an illustration');
}
const packed = largestFreeRect(area, freeCases[2].occupied, styleSpec.spacing.elementGap);
if (packed && packed.w >= 1.6 && packed.h >= 1.6) {
  throw new Error('a full slide should not have room for an illustration');
}

// ── Word budget ────────────────────────────────────────────────────────────
const counted = await checkWordBudget.execute({ slideSpec: slides[1], budget: 20 });
console.log(`word budget: ${counted.words} words vs 20 — within=${counted.withinBudget}`);
if (counted.words === 0) throw new Error('check_word_budget counted nothing');

// ── Element motion ─────────────────────────────────────────────────────────
//
// The one property motion must never break: an entrance ENDS at the element's
// laid-out size. If `to` were anything but 1, every geometry pass upstream —
// the archetype rectangles, the fitted type, the overlap checks — would be
// describing a slide the viewer never actually sees.
for (const effect of ['zoom-in', 'zoom-out'] as const) {
  const entrance = motionSchema.parse({ effect, intensity: 1 });
  const frames = motionFrames(entrance);

  if (frames.to !== 1) {
    throw new Error(`${effect} entrance settles at ${frames.to}, not the element's own size`);
  }
  if (Math.abs(frames.from - 1) !== MAX_ZOOM_DELTA) {
    throw new Error(`${effect} at intensity 1 should travel ${MAX_ZOOM_DELTA}`);
  }
  // Direction: zoom-in comes from smaller, zoom-out from larger.
  const grows = frames.from < 1;
  if (grows !== (effect === 'zoom-in')) throw new Error(`${effect} travels the wrong way`);

  // Hover and click invert the reading: they REST at the real size and depart.
  const hover = motionFrames(motionSchema.parse({ effect, intensity: 1, trigger: 'hover' }));
  if (hover.from !== 1) throw new Error(`${effect} on hover should rest at the laid-out size`);
  if (hover.to > 1 !== (effect === 'zoom-in')) {
    throw new Error(`${effect} on hover departs the wrong way`);
  }
}

const still = motionFrames(motionSchema.parse({ effect: 'none' }));
if (still.from !== 1 || still.to !== 1 || still.fadeFrom !== 1) {
  throw new Error('an unanimated element should not move or fade');
}

// A unit the model wrote onto a duration must not cost a deck.
const suffixed = motionSchema.parse({ effect: 'zoom-in', duration: '0.4s', delay: '250ms' });
if (suffixed.duration !== 0.4 || suffixed.delay !== 0.25) {
  throw new Error(`units not stripped: ${suffixed.duration}s / ${suffixed.delay}s`);
}

// An unrecognised word is a spelling difference, not a broken deck.
const misspelt = motionSchema.parse({ effect: 'zoomIn', easing: 'bouncy' });
if (misspelt.effect !== 'none' || misspelt.easing !== 'ease-out') {
  throw new Error('an unknown motion word should fall back, not throw');
}

// Body prose stays still by default; the things whose arrival is the point move.
if (defaultMotionFor('text', 'body') !== null) {
  throw new Error('body copy should not animate by default');
}
for (const [type, role] of [
  ['text', 'title'],
  ['image', 'illustration'],
  ['statistic', 'body'],
] as const) {
  if (defaultMotionFor(type, role)?.effect !== 'zoom-in') {
    throw new Error(`${type}/${role} should get a default entrance`);
  }
}
console.log(
  `motion: entrances settle at 1.0, travel ${MAX_ZOOM_DELTA} at full intensity, defaults sparse`,
);

// ── The locked style block ─────────────────────────────────────────────────
const envelope = styleEnvelope(styleSpec);
const output = { width: 1280, height: 1440, aspectRatio: '8:9' };
const styleOf = (prompt: string) =>
  JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)).style);

const promptA = buildImagePrompt({
  style: envelope,
  subject: { description: 'a leaf', context: 'Photosynthesis · Leaves make food' },
  output,
});
const promptB = buildImagePrompt({
  style: envelope,
  subject: { description: 'the sun', objects: ['sun', 'clouds'], role: 'spot' },
  output,
});

if (styleOf(promptA) !== styleOf(promptB)) {
  throw new Error('image style block drifted between subjects');
}
console.log(`image prompt: style block locked across subjects (${styleOf(promptA).length} chars)`);

// ── Alignment and contrast: the two rules the renderers share ──────────────
//
// The .pptx builder and the web canvas both read these, so a disagreement here
// is a deck whose preview lies about the file the user downloads.
const theme = themeFromStyleSpec(styleSpec);

const placements: [string, string, { text?: string; items?: string[] } | undefined, string, string][] = [
  ['text', 'title', undefined, 'left', 'top'],
  ['text', 'body', undefined, 'left', 'top'],
  ['statistic', 'body', undefined, 'center', 'middle'],
  // A short card label centres; the same card carrying a sentence does not.
  // Centred prose rags both edges and is the fastest way to look amateur.
  ['card', 'body', { items: ['Following a recipe'] }, 'center', 'middle'],
  [
    'card',
    'body',
    { items: ['Following a recipe — the steps run in a fixed order, each depending on the last'] },
    'left',
    'top',
  ],
  // A list always reads from one left edge, however short its items.
  ['card', 'body', { items: ['One', 'Two'] }, 'left', 'top'],
];

for (const [type, role, content, align, valign] of placements) {
  const got = placementFor(type, role, content);
  if (got.align !== align || got.valign !== valign) {
    throw new Error(
      `placementFor(${type}, ${role}, ${JSON.stringify(content)}) = ${got.align}/${got.valign}, expected ${align}/${valign}`,
    );
  }
}
console.log(`alignment: ${placements.length} placement rules agree`);

// Text that already reads well is left alone; text that does not is replaced.
const onBackground = readableOn(theme.colors.text, theme.colors.background, theme);
if (onBackground !== theme.colors.text) {
  throw new Error('readableOn changed a colour that was already readable');
}

// Grey-on-grey: the case that ships an invisible line if nobody checks.
const invisible = readableOn(theme.colors.surface, theme.colors.surface, theme);
const rescued = contrastRatio(invisible, theme.colors.surface);
if (rescued < MIN_CONTRAST) {
  throw new Error(`readableOn left unreadable text: ratio ${rescued.toFixed(2)}`);
}
console.log(
  `contrast: same-on-same rescued to ${rescued.toFixed(1)}:1 (AA needs ${MIN_CONTRAST})`,
);

// ── Fitting type to its box ────────────────────────────────────────────────
//
// The .pptx and the browser both scale overlong text by this factor, so it has
// to actually make the text fit — otherwise a heading runs over the subtitle
// beneath it in both outputs at once.
const tightBox = { w: 5.9, h: 1.4 };
const heading = 'THE MUGHAL EMPIRE';

if (shrinkToFit('Short', tightBox, 54) !== 1) {
  throw new Error('shrinkToFit scaled text that already fitted');
}

const factor = shrinkToFit(heading, tightBox, 54);
const fittedHeight = estimateTextHeight(heading, tightBox.w, 54 * factor);
if (fittedHeight > tightBox.h) {
  throw new Error(
    `shrinkToFit left ${heading} at ${fittedHeight.toFixed(2)}in in a ${tightBox.h}in box`,
  );
}
console.log(`shrink: "${heading}" 54pt -> ${(54 * factor).toFixed(0)}pt fits ${tightBox.h}in`);

// Capitals are wider, and a heading that ignores that is a heading that wraps.
// Compared in lines rather than inches: height is quantised to whole lines, so
// two strings can need visibly different widths and report the same height.
const capitals = 'THE MUGHAL EMPIRE AND ITS ADMINISTRATION UNDER AKBAR THE GREAT';
const upperLines = estimateLines(capitals, 5.9, 54);
const mixedLines = estimateLines(
  'The Mughal Empire and its Administration under Akbar the Great',
  5.9,
  54,
);
if (upperLines <= mixedLines) {
  throw new Error(
    `uppercase estimated at ${upperLines} lines, mixed case at ${mixedLines} — capitals should need more`,
  );
}
console.log(`casing: uppercase wraps to ${upperLines} lines vs ${mixedLines} mixed`);

// ── Built-in deck templates ────────────────────────────────────────────────
//
// A template is a StyleSpec nobody reviews again: it skips the style analyzer
// AND its critic, so whatever is written in `src/lib/templates.ts` is what
// ships. The properties its docstring claims are therefore checked here rather
// than trusted — a palette that fails AA would be silently rescued by
// `readableOn` into a deck that does not look like the tile the user picked,
// and type below the floor would be silently lifted into a different
// hierarchy. Font availability is checked out of band: it needs the network,
// and this suite has to run offline.
for (const id of TEMPLATE_IDS) {
  const template = DECK_TEMPLATES[id];
  const spec = styleSpecSchema.parse(templateStyleSpec(id));

  if (spec.source.type !== 'template' || spec.source.path !== id) {
    throw new Error(`${id}: source should name the template, got ${JSON.stringify(spec.source)}`);
  }

  // Every pair of colours that can end up as text on a ground.
  const grounds = [spec.colors.background, spec.colors.surface ?? spec.colors.background];
  for (const ground of grounds) {
    for (const [role, ink] of [
      ['primaryText', spec.colors.primaryText],
      ['secondaryText', spec.colors.secondaryText ?? spec.colors.primaryText],
    ] as const) {
      const ratio = contrastRatio(ink, ground);
      if (ratio < MIN_CONTRAST) {
        throw new Error(
          `${id}: ${role} ${ink} on ${ground} is ${ratio.toFixed(1)}:1, below AA's ${MIN_CONTRAST}`,
        );
      }
    }
  }

  // Written above the floor, so `legibleSizes` has nothing to lift and the
  // hierarchy the template describes is the one the deck gets.
  const sizes = {
    title: spec.typography.title.size,
    subtitle: spec.typography.subtitle?.size ?? 0,
    body: spec.typography.body.size,
    caption: spec.typography.caption?.size ?? 0,
  };
  for (const [role, floor] of Object.entries(MIN_TYPE_SIZES)) {
    const size = sizes[role as keyof typeof sizes];
    if (size < floor) throw new Error(`${id}: ${role} is ${size}pt, below the ${floor}pt floor`);
  }
  const theme = themeFromStyleSpec(spec);
  if (theme.sizes.title !== sizes.title || theme.sizes.body !== sizes.body) {
    throw new Error(
      `${id}: themeFromStyleSpec changed the scale (${sizes.title}/${sizes.body} -> ` +
        `${theme.sizes.title}/${theme.sizes.body}) — the template is not describing what ships`,
    );
  }

  // `visualLanguage` is read verbatim into every image prompt for the deck, so
  // an adjective here is a deck's worth of vague illustrations.
  if (template.style.visualLanguage.split(/\s+/).length < 12) {
    throw new Error(`${id}: visualLanguage is too short to be art direction`);
  }
  if (template.style.layoutPrinciples.length === 0) {
    throw new Error(`${id}: no layout principles`);
  }
}
console.log(
  `templates: ${TEMPLATE_IDS.length} built-in designs, all AA-legible and above the type floor`,
);

if (!contains({ x: 0, y: 0, w: 4, h: 3 }, { x: 1, y: 1, w: 2, h: 1 })) {
  throw new Error('contains() rejected a box that is plainly inside');
}
if (contains({ x: 0, y: 0, w: 4, h: 3 }, { x: 3, y: 1, w: 2, h: 1 })) {
  throw new Error('contains() accepted a box that overhangs');
}

const built = await createPptx.execute({ styleSpec, slideSpecs: slides });
console.log(`built: ${built.filename} (${built.slideCount} slides)`);

const valid = await validatePptx.execute({
  pptxPath: built.pptxPath,
  expectedSlideCount: built.slideCount,
});

// A card's words must actually reach the file. The shape rendering on its own
// proves nothing — that is precisely how three blank rectangles shipped, with
// the validator passing them the whole way.
const archive = await JSZip.loadAsync(await readFile(built.pptxPath));
const slideXml = await Promise.all(
  Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .map((name) => archive.files[name].async('string')),
);
const allText = slideXml.join('');

for (const phrase of ['Read the recipe end to end', 'Preheat the oven']) {
  if (!allText.includes(phrase)) {
    throw new Error(`card text missing from the .pptx: "${phrase}"`);
  }
}
console.log(`card items: both card labels present across ${slideXml.length} slide parts`);
console.log(`validate: valid=${valid.valid} slides=${valid.slideCount} bytes=${valid.bytes}`);
if (valid.problems.length) console.log('problems:', valid.problems);

if (!valid.valid) process.exit(1);
console.log('\nOK');
