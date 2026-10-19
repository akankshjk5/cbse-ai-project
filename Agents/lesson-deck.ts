import 'server-only';

/**
 * A teacher's request, through the local planner, into an editable deck.
 *
 * The seven-slide sample in `scripts/make-original-deck.mts` is a fixture: its
 * words were written by hand so the builder could be exercised without a
 * planner. It stays as a regression fixture and is never presented as model
 * output. This module is the path a teacher actually takes.
 *
 * Everything here composes pieces that already exist —
 * `generateStructuredLocally` for the plan, `slotsFor` for geometry,
 * `illustrateSlides` for pictures, `buildPptx` to write the file — rather than
 * a second pipeline beside them. The only new thing is the shape of the plan
 * and how it becomes slides.
 *
 * Content is `original_generated` throughout. The planner is asked for an
 * original explanation of a topic, never for a reproduction of a textbook, and
 * nothing here emits a citation, page number or claim of approval.
 */

import { z } from 'zod';

import { generateStructuredLocally, LocalPlannerError } from './local-planner';
import { buildPptx } from './pptx/builder';
import { slotsFor } from './pptx/layouts';
import { illustrateSlides } from './tools/illustrate-slides';
import { AgentError, styleSpecSchema, type SlideSpec, type StyleSpec } from './types';

/** What the TTS and caption stacks already support, so a deck matches a video. */
export const LESSON_DECK_LANGUAGES = ['en-IN', 'hi-IN', 'kn-IN'] as const;
export type LessonDeckLanguage = (typeof LESSON_DECK_LANGUAGES)[number];

export const lessonDeckRequestSchema = z.object({
  classLevel: z.number().int().min(1).max(12),
  subject: z.string().trim().min(2).max(100),
  /** A chapter name or a narrower topic; the planner is told which it got. */
  topic: z.string().trim().min(3).max(300),
  language: z.enum(LESSON_DECK_LANGUAGES),
  /** The teacher's own words for what the class should be able to do after. */
  objectives: z.array(z.string().trim().min(5).max(200)).min(1).max(6),
  /**
   * Content slides between the opening and the summary. The deck is this plus
   * a title, an objectives slide, a summary and a knowledge check.
   */
  contentSlides: z.number().int().min(2).max(10).default(4),
  visualStyle: z.string().trim().min(3).max(80).default('clean diagrammatic explainer'),
  /** Whether a failure to draw a picture should fail the deck. */
  illustrations: z.enum(['required', 'optional', 'none']).default('optional'),
});
export type LessonDeckRequest = z.infer<typeof lessonDeckRequestSchema>;

/**
 * What the planner must return.
 *
 * Deliberately narrow. A planner free to return prose or markup produces
 * something that has to be parsed before it can be laid out, and a parser is
 * where a deck silently becomes one slide of run-on text. Asking for the
 * structure directly means a malformed answer fails here, loudly, before a
 * file exists.
 */
export const lessonPlanSchema = z.object({
  title: z.string().min(3).max(90),
  subtitle: z.string().min(3).max(140),
  objectives: z.array(z.string().min(5).max(160)).min(1).max(6),
  slides: z.array(z.object({
    heading: z.string().min(3).max(90),
    /** Two or three sentences a teacher would say. Not a paragraph of prose. */
    explanation: z.string().min(40).max(600),
    /** Concrete, everyday, and the teacher's class would recognise it. */
    example: z.string().min(10).max(300),
    /**
     * What a picture should show, in one line. Becomes the image prompt —
     * which is why it must never be the whole explanation: the image model
     * takes a concise caption, and a paragraph produces a picture of a
     * paragraph.
     */
    diagram: z.string().min(10).max(200).nullable(),
  })).min(2).max(10),
  summary: z.array(z.string().min(5).max(160)).min(2).max(5),
  knowledgeCheck: z.array(z.string().min(10).max(200)).min(2).max(5),
});
export type LessonPlan = z.infer<typeof lessonPlanSchema>;

const LANGUAGE_NAME: Record<LessonDeckLanguage, string> = {
  'en-IN': 'Indian English',
  'hi-IN': 'Hindi',
  'kn-IN': 'Kannada',
};

function systemPrompt(request: LessonDeckRequest): string {
  return [
    `You plan lessons for Class ${request.classLevel} ${request.subject}.`,
    `Write everything in ${LANGUAGE_NAME[request.language]}.`,
    '',
    'Write an ORIGINAL explanation in your own words. Do not reproduce,',
    'paraphrase or quote any textbook passage, and do not cite a book, a page',
    'number or an approving authority — this lesson has no such source and',
    'claiming one would be false.',
    '',
    'Each explanation is two or three sentences a teacher would say aloud.',
    'Each example is something this age group has actually seen.',
    'Each diagram line is ONE short phrase naming what a picture should show;',
    'it is used as an image prompt, so it must not restate the explanation.',
    'Diagram descriptions contain no words that must appear in the picture —',
    'all lettering is drawn by the deck, never generated.',
  ].join('\n');
}

function userPrompt(request: LessonDeckRequest): string {
  return [
    `Topic: ${request.topic}`,
    `Class: ${request.classLevel}`,
    `Subject: ${request.subject}`,
    '',
    'The teacher wants the class to be able to:',
    ...request.objectives.map((objective) => `  - ${objective}`),
    '',
    `Plan exactly ${request.contentSlides} content slides between the objectives`,
    'and the summary.',
  ].join('\n');
}

/**
 * Ask the local planner for a lesson.
 *
 * A failure is reported as a failure. There is no path from here to the
 * fixture: serving hand-written content when a model was expected, and
 * labelling it as generated, is the one outcome this function must never
 * produce.
 */
export async function planLessonDeck(request: LessonDeckRequest): Promise<{
  plan: LessonPlan; model: string | null;
}> {
  try {
    const result = await generateStructuredLocally({
      systemPrompt: systemPrompt(request),
      userPrompt: userPrompt(request),
      schema: lessonPlanSchema,
      maxNewTokens: 4000,
    });
    if (result.value.slides.length !== request.contentSlides) {
      throw new AgentError(
        `The planner returned ${result.value.slides.length} content slides, `
        + `not the ${request.contentSlides} requested.`,
        'PLAN_SHAPE_MISMATCH', 'lesson-deck');
    }
    return { plan: result.value, model: result.model };
  } catch (error) {
    if (error instanceof LocalPlannerError) {
      throw new AgentError(
        `Lesson planning needs the local planner, and it did not answer: ${error.message}`,
        'PLANNER_UNAVAILABLE', 'lesson-deck');
    }
    throw error;
  }
}

export function defaultStyleSpec(request: LessonDeckRequest): StyleSpec {
  return styleSpecSchema.parse({
    version: '1',
    source: { type: 'template', path: 'Agents/lesson-deck.ts' },
    slideSize: { width: 13.333, height: 7.5, aspectRatio: '16:9' },
    colors: {
      background: '#F4F6F8', surface: '#FFFFFF', primaryText: '#16202B',
      secondaryText: '#53616F', accent: '#1F6F8B', border: '#C9D4DD',
    },
    typography: {
      // Faces with the script coverage the three languages need. A heading
      // font without Kannada glyphs renders a Kannada deck as boxes.
      headingFont: request.language === 'en-IN' ? 'Georgia' : 'Nirmala UI',
      bodyFont: request.language === 'en-IN' ? 'Verdana' : 'Nirmala UI',
      headingFontFallbacks: ['Noto Sans', 'serif'],
      bodyFontFallbacks: ['Noto Sans', 'sans-serif'],
      title: { size: 40, weight: 700 },
      subtitle: { size: 20, weight: 400 },
      body: { size: 13, weight: 400 },
      caption: { size: 9, weight: 400 },
    },
    spacing: { outerMargin: 0.6, sectionGap: 0.35, elementGap: 0.25, paragraphGap: 0.14 },
    visualLanguage: request.visualStyle,
    layoutPrinciples: ['one idea per slide', 'generous whitespace'],
  });
}

/**
 * The plan as slides the builder understands.
 *
 * Geometry comes from `slotsFor`, so this chooses a composition and never a
 * coordinate — the same contract the designer agent works under.
 */
export function composeSlideSpecs(
  plan: LessonPlan, request: LessonDeckRequest, styleSpec: StyleSpec,
): SlideSpec[] {
  const title = slotsFor('title-only', styleSpec);
  const two = slotsFor('two-column', styleSpec);
  const hero = slotsFor('hero-right', styleSpec);
  const want = (map: Record<string, unknown>, name: string) => {
    const box = map[name];
    if (!box) throw new AgentError(
      `Archetype has no "${name}" slot; available: ${Object.keys(map).join(', ')}`,
      'MISSING_SLOT', 'lesson-deck');
    return box as { x: number; y: number; w: number; h: number };
  };

  const slides: SlideSpec[] = [];
  let n = 1;

  slides.push({
    slideNumber: n++, layout: 'title', archetype: 'title-only', title: plan.title,
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: want(title, 'title'), text: plan.title },
      { type: 'text', role: 'subtitle', slot: 'subtitle', box: want(title, 'subtitle'),
        text: plan.subtitle },
    ],
    speakerNotes:
      'Original content generated for this lesson. Not drawn from a textbook and not '
      + 'checked against one — do not present it as syllabus-verified.',
  });

  slides.push({
    slideNumber: n++, layout: 'two-column', archetype: 'two-column',
    title: 'What you should be able to do',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: want(two, 'title'),
        text: 'What you should be able to do' },
      { type: 'card', role: 'objectives', slot: 'col-1', box: want(two, 'col-1'),
        items: plan.objectives.slice(0, Math.ceil(plan.objectives.length / 2)) },
      { type: 'card', role: 'objectives-2', slot: 'col-2', box: want(two, 'col-2'),
        items: plan.objectives.slice(Math.ceil(plan.objectives.length / 2)) },
    ],
  });

  for (const slide of plan.slides) {
    const elements: SlideSpec['elements'] = [
      { type: 'text', role: 'title', slot: 'title', box: want(hero, 'title'), text: slide.heading },
      { type: 'text', role: 'body', slot: 'body', box: want(hero, 'body'),
        text: `${slide.explanation}\n\n${slide.example}` },
    ];
    // An image element with no `imagePath` is what `illustrateSlides` looks
    // for. Omitting it is how a text-only deck is requested.
    // The slot is `image`, and `imagePrompt` is the field illustrateSlides
    // reads; an element with no `imagePath` is what it treats as outstanding.
    if (slide.diagram && request.illustrations !== 'none' && hero.image) {
      elements.push({
        type: 'image', role: 'illustration', slot: 'image', box: want(hero, 'image'),
        imagePrompt: slide.diagram,
      });
    }
    slides.push({
      // `layout` is the older vocabulary and `archetype` the one that decides
      // geometry; hero-right has no layout of its own, so the nearest true
      // description is a single column of prose.
      slideNumber: n++, layout: 'single-column', archetype: 'hero-right',
      title: slide.heading, elements,
    });
  }

  slides.push({
    slideNumber: n++, layout: 'two-column', archetype: 'two-column',
    title: 'The idea in short',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: want(two, 'title'),
        text: 'The idea in short' },
      { type: 'card', role: 'summary', slot: 'col-1', box: want(two, 'col-1'),
        items: plan.summary },
      { type: 'text', role: 'body', slot: 'col-2', box: want(two, 'col-2'),
        text: plan.summary.join(' ') },
    ],
  });

  slides.push({
    slideNumber: n++, layout: 'two-column', archetype: 'two-column', title: 'Check yourself',
    elements: [
      { type: 'text', role: 'title', slot: 'title', box: want(two, 'title'),
        text: 'Check yourself' },
      { type: 'card', role: 'questions', slot: 'col-1', box: want(two, 'col-1'),
        items: plan.knowledgeCheck },
      { type: 'text', role: 'body', slot: 'col-2', box: want(two, 'col-2'),
        text: 'Answer each in a sentence of your own.' },
    ],
    speakerNotes: 'Knowledge check. Answers are deliberately not on the slide.',
  });

  return slides;
}

export interface LessonDeckResult {
  path: string;
  slideCount: number;
  contentMode: 'original_generated';
  plannerModel: string | null;
  imagesGenerated: number;
  imageFailures: string[];
  /** True only when a model produced every picture that was asked for. */
  illustrated: boolean;
}

/**
 * The whole path: request, plan, slides, pictures, file.
 */
export async function buildLessonDeck(
  input: unknown, outputPath: string, imageDir?: string,
): Promise<LessonDeckResult> {
  const request = lessonDeckRequestSchema.parse(input);
  const { plan, model } = await planLessonDeck(request);
  const styleSpec = defaultStyleSpec(request);

  let slides = composeSlideSpecs(plan, request, styleSpec);
  let generated: string[] = [];
  let failures: string[] = [];

  const wantsPictures = request.illustrations !== 'none'
    && slides.some((s) => s.elements.some((e) => e.type === 'image'));

  if (wantsPictures) {
    const result = await illustrateSlides(slides, styleSpec, imageDir ?? '.');
    slides = result.slideSpecs;
    generated = result.generated;
    failures = result.failures;

    // `optional` means a text-only deck is acceptable; `required` means it is
    // not. Either way the failures are reported rather than absorbed, so a
    // deck with no pictures is never described as illustrated.
    if (failures.length > 0 && request.illustrations === 'required') {
      throw new AgentError(
        `Illustrations were required and ${failures.length} could not be made: `
        + failures.join('; '),
        'ILLUSTRATION_FAILED', 'lesson-deck');
    }
  }

  const built = await buildPptx(slides, styleSpec, outputPath);
  return {
    path: outputPath,
    slideCount: built.slideCount,
    contentMode: 'original_generated',
    plannerModel: model,
    imagesGenerated: generated.length,
    imageFailures: failures,
    illustrated: wantsPictures && failures.length === 0 && generated.length > 0,
  };
}
