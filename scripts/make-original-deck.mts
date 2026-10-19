/**
 * One editable deck, built from an original explanation rather than a textbook.
 *
 *   npm run deck:original -- --out ops/cloud/out/original-lesson.pptx
 *
 * The content here was written for this script. It is not copied from, and
 * does not paraphrase, any Karnataka or NCERT textbook: no passage, diagram or
 * page layout is reproduced, and the deck carries no citation, page number or
 * claim of official approval, because inventing one would be worse than having
 * none. `content_mode` is `original_generated` for exactly that reason.
 *
 * It drives `Agents/pptx/builder.ts` — the builder the product uses — rather
 * than a parallel pipeline, so a change to slide rendering shows up here.
 *
 * The topic is deliberately ordinary physics a teacher could set from any
 * syllabus, explained in this file's own words.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { buildPptx } from '../Agents/pptx/builder.ts';
import { slotsFor } from '../Agents/pptx/layouts.ts';
import { styleSpecSchema, type SlideSpec } from '../Agents/types.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const out = arg('out', 'ops/cloud/out/original-lesson.pptx');

/**
 * A plain, legible identity. Chosen here rather than generated, because this
 * script's subject is the deck structure and the content mode, not the design
 * agent — which is a separate stage with its own tests.
 */
const styleSpec = styleSpecSchema.parse({
  version: '1',
  // The schema only models a style derived from an image or a template. This
  // deck's style was chosen in this file, so the nearest honest value is the
  // template path rather than a reference image that does not exist.
  source: { type: 'template', path: 'scripts/make-original-deck.mts' },
  slideSize: { width: 13.333, height: 7.5, aspectRatio: '16:9' },
  colors: {
    background: '#F4F6F8',
    surface: '#FFFFFF',
    primaryText: '#16202B',
    secondaryText: '#53616F',
    accent: '#1F6F8B',
    border: '#C9D4DD',
  },
  typography: {
    headingFont: 'Georgia',
    bodyFont: 'Verdana',
    headingFontFallbacks: ['Times New Roman', 'serif'],
    bodyFontFallbacks: ['Arial', 'sans-serif'],
    title: { size: 40, weight: 700 },
    subtitle: { size: 20, weight: 400 },
    body: { size: 13, weight: 400 },
    caption: { size: 9, weight: 400 },
  },
  spacing: { outerMargin: 0.6, sectionGap: 0.35, elementGap: 0.25, paragraphGap: 0.14 },
  visualLanguage: 'clean diagrammatic explainer',
  layoutPrinciples: ['one idea per slide', 'generous whitespace'],
});

const title = slotsFor('title-only', styleSpec);
const two = slotsFor('two-column', styleSpec);
const three = slotsFor('three-column', styleSpec);
const hero = slotsFor('hero-right', styleSpec);

/** Keeps a missing slot loud instead of silently dropping an element. */
function slot(map: Record<string, unknown>, name: string) {
  const box = map[name];
  if (!box) {
    throw new Error(
      `This archetype has no "${name}" slot. Available: ${Object.keys(map).join(', ')}`);
  }
  return box as { x: number; y: number; w: number; h: number };
}

const slides: SlideSpec[] = [
  {
    slideNumber: 1,
    layout: 'title',
    archetype: 'title-only',
    title: 'Why Ice Floats',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(title, 'title'),
        text: 'Why Ice Floats' },
      { type: 'text', role: 'subtitle', slot: 'subtitle', box: slot(title, 'subtitle'),
        text: 'What happens to water when it freezes' },
    ],
    speakerNotes:
      'Original explanation written for this lesson. Not taken from a textbook, '
      + 'and not checked against one — do not present it as syllabus-verified.',
  },
  {
    slideNumber: 2,
    layout: 'two-column',
    archetype: 'two-column',
    title: 'What you should be able to do',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(two, 'title'),
        text: 'What you should be able to do' },
      { type: 'card', role: 'objectives-a', slot: 'col-1', box: slot(two, 'col-1'),
        items: [
          'Say what density means in your own words',
          'Explain why most things shrink when they cool',
        ] },
      { type: 'card', role: 'objectives-b', slot: 'col-2', box: slot(two, 'col-2'),
        items: [
          'Describe what water does differently below 4 °C',
          'Use that to explain why a pond freezes from the top',
        ] },
    ],
  },
  {
    slideNumber: 3,
    layout: 'hero-right',
    archetype: 'hero-right',
    title: 'Density decides what floats',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(hero, 'title'),
        text: 'Density decides what floats' },
      { type: 'text', role: 'body', slot: 'body', box: slot(hero, 'body'),
        text:
          'Density is how much mass is packed into a given space. Put two things '
          + 'of the same size side by side and the heavier one is denser.\n\n'
          + 'Anything less dense than the liquid around it floats. A cork floats '
          + 'on water because a cork-sized piece of water weighs more than the cork.' },
    ],
  },
  {
    slideNumber: 4,
    layout: 'hero-right',
    archetype: 'hero-right',
    title: 'Water breaks the usual rule',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(hero, 'title'),
        text: 'Water breaks the usual rule' },
      { type: 'text', role: 'body', slot: 'body', box: slot(hero, 'body'),
        text:
          'Cool almost any liquid and its particles slow down, crowd together, '
          + 'and the liquid gets denser. Water does this too — until about 4 °C.\n\n'
          + 'Below that, the molecules begin locking into a six-sided pattern that '
          + 'holds them further apart than they were as a liquid. The same water '
          + 'now takes up more room, so ice is about a tenth less dense than the '
          + 'water it came from. Less dense means it floats.' },
    ],
  },
  {
    slideNumber: 5,
    layout: 'three-column',
    archetype: 'three-column',
    title: 'Where you have already seen this',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(three, 'title'),
        text: 'Where you have already seen this' },
      { type: 'card', role: 'example-1', slot: 'col-1', box: slot(three, 'col-1'),
        items: ['A water bottle left in the freezer bulges, and sometimes splits. '
          + 'The water needed more room once it froze.'] },
      { type: 'card', role: 'example-2', slot: 'col-2', box: slot(three, 'col-2'),
        items: ['Ice cubes sit on top of a drink instead of sinking, so the cold '
          + 'stays where you can see it.'] },
      { type: 'card', role: 'example-3', slot: 'col-3', box: slot(three, 'col-3'),
        items: ['A pond freezes into a lid. The water underneath stays liquid, '
          + 'which is how fish survive a cold winter.'] },
    ],
  },
  {
    slideNumber: 6,
    layout: 'two-column',
    archetype: 'two-column',
    title: 'The idea in three lines',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(two, 'title'),
        text: 'The idea in three lines' },
      { type: 'card', role: 'summary', slot: 'col-1', box: slot(two, 'col-1'),
        items: [
          'Less dense than the liquid around it means it floats',
          'Water is unusual: below 4 °C it expands as it cools',
          'So ice floats, and ponds freeze from the top down',
        ] },
      { type: 'text', role: 'body', slot: 'col-2', box: slot(two, 'col-2'),
        text:
          'If water behaved like most liquids, ice would sink. A pond would '
          + 'freeze from the bottom up and stay frozen, and very little would '
          + 'survive the winter in it.' },
    ],
  },
  {
    slideNumber: 7,
    layout: 'two-column',
    archetype: 'two-column',
    title: 'Check yourself',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: slot(two, 'title'),
        text: 'Check yourself' },
      { type: 'card', role: 'questions', slot: 'col-1', box: slot(two, 'col-1'),
        items: [
          '1. Two blocks are the same size. One floats, one sinks. What differs?',
          '2. Why does a sealed bottle of water crack in the freezer?',
          '3. A pond freezes. Where is the liquid water, and why does it matter?',
        ] },
      { type: 'text', role: 'body', slot: 'col-2', box: slot(two, 'col-2'),
        text:
          'Answer in a sentence each, in your own words. If you can explain '
          + 'question 3 to someone who has not seen this lesson, you have it.' },
    ],
    speakerNotes: 'Knowledge check. Answers are not printed on the slide on purpose.',
  },
];

await mkdir(dirname(out), { recursive: true });
const result = await buildPptx(slides, styleSpec, out);

console.log(`wrote ${out}`);
console.log(`  slides: ${result.slideCount}`);
console.log(`  content mode: original_generated`);
console.log(`  source references: none — nothing here is drawn from a textbook`);
