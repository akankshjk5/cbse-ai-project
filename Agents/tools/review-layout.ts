import 'server-only';

import { z } from 'zod';

import { generateStructured } from '../Agent';
import { contactSheet, rasterizeSlides } from '../pptx/rasterize';
import { serverEnv } from '@/lib/env';
import type { QAReport, SlideSpec, StyleSpec } from '../types';

/**
 * Looks at the deck.
 *
 * Every other check in this pipeline reads the spec: is the box on the canvas,
 * do two boxes overlap, does the text fit the height we computed. All of them
 * are exact and none of them can see anything. They cannot tell you the title
 * is sitting on someone's face, that one slide's picture is a different style
 * from the rest, or that the deck simply looks unfinished — and those are the
 * first things a person notices.
 *
 * So the slides are rendered (see ../pptx/rasterize) and a vision model is
 * asked to look. This is the one stage whose input is a picture rather than
 * JSON, which is exactly why it is worth its cost: every system that produces
 * good decks closes this loop somehow, and it is the only check here that can
 * fail for a reason nobody thought to write a rule for.
 *
 * Two things keep it honest:
 *
 * 1. **It reports, it does not decide.** Findings come back capped at `major`,
 *    like the `pptx-reviewer`'s. A revision round costs about as much as the
 *    rest of the build, and that spend follows from counted facts — a
 *    validation failure, an out-of-bounds box, a word count — never from an
 *    opinion about a picture.
 * 2. **It never fails the build.** No fonts, no network, a model that will not
 *    answer: the check is skipped and the deck ships. A visual review that
 *    cannot run should cost the review.
 */

const findingSchema = z.object({
  slideNumber: z.number().int().positive().optional(),
  category: z
    .enum(['overflow', 'overlap', 'readability', 'style', 'content', 'technical'])
    .catch('style'),
  severity: z.enum(['major', 'minor']).catch('minor'),
  description: z.string().min(1),
  recommendation: z.string().optional(),
});

const visualReviewSchema = z.object({
  /** True when nothing on the sheet would embarrass the person presenting it. */
  looksRight: z.boolean(),
  findings: z.array(findingSchema).default([]),
});

export type VisualReview = z.infer<typeof visualReviewSchema>;

/**
 * The checklist.
 *
 * Deliberately concrete and deliberately about things a picture reveals. Asking
 * a model whether a deck is "good" gets an essay; asking whether any text
 * touches an edge gets an answer. Each line names a failure that has actually
 * shipped from this pipeline.
 */
const CHECKLIST = [
  'Text running out of its box, off the slide, or cut off mid-word.',
  'Two elements overlapping so that either becomes hard to read.',
  'Text sitting on a busy part of a picture, or too close in colour to what is behind it.',
  'Type so small it could not be read from the back of a room.',
  'A heading in a different typeface or weight from the other headings.',
  'A picture whose style does not match the others — different medium, palette, or level of detail.',
  'A slide much emptier or much fuller than the rest of the deck.',
  'Elements that should line up with each other and do not.',
  'Words rendered INSIDE a generated picture (the pictures should carry no lettering at all).',
];

export interface ReviewLayoutInput {
  slideSpecs: SlideSpec[];
  styleSpec: StyleSpec;
}

/**
 * Renders the deck and asks a vision model what is wrong with it.
 *
 * Returns an empty finding list when the check could not run, which is
 * indistinguishable to the caller from a clean deck — and correctly so: in
 * both cases there is nothing to act on.
 */
export async function reviewLayoutVisually(
  input: ReviewLayoutInput,
): Promise<{ review: VisualReview | null; slidesSeen: number }> {
  if (!serverEnv.visualReviewEnabled) return { review: null, slidesSeen: 0 };

  let images: { slideNumber: number; png: Buffer }[];
  try {
    images = await rasterizeSlides(input.slideSpecs, input.styleSpec);
  } catch {
    return { review: null, slidesSeen: 0 };
  }

  if (images.length === 0) return { review: null, slidesSeen: 0 };

  const sheet = await contactSheet(images).catch(() => null);
  if (!sheet) return { review: null, slidesSeen: 0 };

  const theme = input.styleSpec.typography;

  try {
    const review = await generateStructured({
      model: serverEnv.openRouterVisionModel,
      images: [`data:image/png;base64,${sheet.toString('base64')}`],
      systemPrompt: [
        'You are the Visual Reviewer, the last stage of a slide-generation pipeline.',
        'You are shown every slide of one deck on a single contact sheet, in order,',
        'left to right and top to bottom. You are the only stage that can SEE the',
        'deck — everything before you inspected numbers.',
        '',
        'Report only what is visible in the picture. Do not infer problems from what',
        'you imagine the underlying data says, and do not comment on the wording or',
        'the subject matter: another stage owns those, and it has the facts.',
        '',
        'A deck with nothing wrong is the normal outcome. Say so rather than',
        'finding something to justify the call.',
      ].join('\n'),
      userPrompt: [
        `This deck has ${images.length} slides. Check each one for:`,
        ...CHECKLIST.map((line) => `  - ${line}`),
        '',
        `The deck's intended typefaces are ${theme.headingFont} for headings and`,
        `${theme.bodyFont} for body copy. Flag a heading that plainly does not match`,
        'the others; you cannot identify a typeface by name from an image, so do not try.',
        '',
        'Number the slides as they appear on the sheet, starting at 1.',
        'Return a VisualReview as JSON. `severity` is `major` for something a viewer',
        'would notice immediately, `minor` for polish. If nothing is wrong, return',
        '`looksRight: true` and an empty findings list.',
      ].join('\n'),
      schema: visualReviewSchema,
      stage: 'visual-reviewer',
      // A cheap look. This stage is worth its cost because it catches what
      // nothing else can, not because it thinks hard about it.
      effort: 'low',
    });

    return { review, slidesSeen: images.length };
  } catch {
    // A model that will not answer costs the check, never the deck.
    return { review: null, slidesSeen: images.length };
  }
}

/** The visual findings as QA issues, capped at `major`. */
export function toQaIssues(review: VisualReview): QAReport['issues'] {
  return review.findings.map((finding) => ({
    severity: finding.severity,
    slideNumber: finding.slideNumber,
    category: finding.category,
    description: `Looks wrong: ${finding.description}`,
    recommendation: finding.recommendation,
  }));
}
