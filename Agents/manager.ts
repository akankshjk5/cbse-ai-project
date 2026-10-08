import 'server-only';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { generateStructured } from './Agent';
import { MEMORY_KEYS, disposeMemory, openMemory, type Memory, type MemoryListener } from './memory';
import {
  MAX_STAGGER,
  STAGGER_STEP,
  defaultMotionFor,
  isAnimated,
  motionSchema,
  type Motion,
} from './motion';
import { withReasoning } from './reasoning';
import { loadSkill } from './skill-loader';
import { analyzeStyleImage, readStyleImageAsDataUrl } from './tools/analyze-style-image';
import { checkGoogleFont } from './tools/check-google-font';
import {
  ARCHETYPE_GUIDE,
  LAYOUT_ARCHETYPES,
  slotsFor,
  stackInSlot,
  type LayoutSlot,
} from './pptx/layouts';
import { fitFontSize, loadFont, measuredHeight, sanitizeMathText } from './pptx/text-metrics';
import { estimateTextHeight } from './pptx/theme';
import { MIN_BACKDROP_DIM, themeFromStyleSpec } from './pptx/theme-resolve';
import {
  contentArea,
  fitToSlide,
  isWithinSlide,
  largestFreeRect,
  overlaps,
} from './pptx/positioning';
import { checkOverflow } from './tools/check-overflow';
import { checkWordBudget } from './tools/check-word-budget';
import { reviewLayoutVisually, toQaIssues } from './tools/review-layout';
import { generateImageTool } from './tools/generate-image';
import { illustrateSlides } from './tools/illustrate-slides';
import { readDocument, type ReadDocumentOutput } from './tools/read-document';
import { createPptx } from './tools/create-pptx';
import { validatePptx } from './tools/validate-pptx';
import { serverEnv } from '@/lib/env';
import {
  AgentError,
  DEFAULT_WORD_BUDGET,
  MIN_BUDGET_USE,
  SLIDE_SIZES,
  TITLE_WORD_BUDGET,
  backgroundPlanSchema,
  contentPlanSchema,
  critiqueSchema,
  fontPlanSchema,
  qaReportSchema,
  researchBriefSchema,
  slideSpecSchema,
  styleSpecSchema,
  type AgentState,
  type BackgroundPlan,
  type ContentPlan,
  type Critique,
  type FontChoice,
  type FontPlan,
  type QAReport,
  type ResearchBrief,
  type Box,
  type SlideAspectRatio,
  type SlideElement,
  type SlideSpec,
  type StyleSpec,
} from './types';
import { z } from 'zod';

/**
 * The orchestrator.
 *
 * Holds the state, calls each specialist in turn, and decides what happens
 * between them. Deliberately thin on presentation logic — layout maths lives
 * in ./pptx, deterministic work lives in ./tools, and the reasoning lives in
 * the Markdown specialists under ./Skills.
 *
 * ## The order, and why it is an order
 *
 * ```
 *   research  →  outline  →  style  →  write  →  illustrate  →  font + build  →  QA
 * ```
 *
 * Each stage consumes the one before it, and the sequence is strict on
 * purpose. Facts have to exist before a narrative can select from them; the
 * narrative has to exist before slides can be written to a word budget; the
 * StyleSpec has to exist before an image can be generated in the deck's own
 * look. Running two of these concurrently to save a minute means the second
 * one is working from an assumption instead of a result.
 *
 * The one stage whose position is not obvious is **fonts**. It could run right
 * after the style analysis — it only needs the analyzer's typeface estimate —
 * but it belongs to the build: choosing a family is the last decision before
 * the .pptx is assembled, it is verified against a live Google Fonts lookup,
 * and putting it there keeps the failure ("no such family") next to the step
 * that has to cope with it.
 *
 * Each specialist runs in isolated mode: it is handed a prompt and inputs,
 * returns a validated result, and control comes straight back here. Nothing
 * mutates state except this class. What the specialists share instead is the
 * run's working memory — see ./memory — which every prompt below includes a
 * digest of, so stage six knows what stage two decided without stage two
 * having to be re-run or re-summarised by hand.
 */

export interface ManagerInput {
  userRequest: string;
  styleReference?: { imagePath: string };
  /**
   * A design system chosen rather than analyzed — one of the built-in
   * templates (`src/lib/templates.ts`).
   *
   * When present it wins over `styleReference` and the style-analyzer stage
   * does not run: there is nothing for it to work out. The look is still a
   * real StyleSpec and every downstream stage reads it exactly as it reads an
   * analyzed one, so this is a different *source* of the design system, not a
   * different code path through the pipeline.
   */
  stylePreset?: StyleSpec;
  sourceFiles?: string[];
  /** Called as each milestone is recorded, so a run can be watched live. */
  onLog?: MemoryListener;
  /**
   * Where generated illustrations are written. The caller supplies it because
   * the caller is the one that has to upload them afterwards and clean up.
   */
  imageDir?: string;
  /**
   * Cache key for this run's working memory. The caller passes its job id so
   * the memory can be found — and disposed of — from outside the Manager.
   */
  runId?: string;
  /** Slides the user asked for, when they said. Advisory; the planner decides. */
  targetSlideCount?: number;
}

export interface GenerationResult {
  success: boolean;
  presentation?: {
    id: string;
    filename: string;
    downloadUrl: string;
    slideCount: number;
  };
  qa?: QAReport;
  error?: { code: string; message: string };
  /**
   * Server-side build output, for the caller that has to store it: the .pptx on
   * local disk plus the specs it was built from. Never serialise this to a
   * client — `pptxPath` is a filesystem path.
   */
  artifacts?: {
    pptxPath: string;
    styleSpec: StyleSpec;
    slideSpecs: SlideSpec[];
    /** Illustrations written to disk, for the caller to store. */
    imagePaths: string[];
  };
}

/**
 * What the draft phase produces: everything there is to review.
 *
 * The build stops here and waits for a person. Research and planning together
 * cost about a cent; style, writing and illustration cost twenty to thirty
 * times that. Showing the outline first is what turns "the deck is wrong" from
 * a refund into a conversation.
 */
export interface DraftResult {
  success: boolean;
  research?: ResearchBrief;
  plan?: ContentPlan;
  error?: { code: string; message: string };
}

/**
 * Bounded so a deck that keeps failing QA cannot loop forever.
 *
 * `1` means the reviewer is consulted at most twice total: once on the first
 * build, and once more on the single revision that follows if it did not
 * pass. A revision that still fails ships as-is rather than asking a third
 * time — each round is a full rebuild, so the cost of chasing a clean pass
 * grows faster than the odds of getting one.
 */
const MAX_REVISIONS = 1;

/**
 * How much extracted document text the Researcher is given.
 *
 * A textbook chapter is a hundred thousand characters and a deck needs the
 * shape of it, not all of it. Truncation is reported rather than silent, so a
 * brief built from the first half of a document says so.
 */
const RESEARCH_CONTEXT_CHARS = 80_000;

/** Over budget by more than this fraction is a bug, not a rounding difference. */
const BUDGET_TOLERANCE = 0.25;

/**
 * A picture needs at least this much room to be worth putting on a slide.
 *
 * Below it the illustration is smaller than the caption under it, which reads
 * as a mistake rather than as design — and the slide is better served by a
 * backdrop, which needs no room at all.
 */
const MIN_VISUAL_EDGE = 1.6;
const MIN_VISUAL_AREA = 4.0;

/** Beyond this the "picture" is a letterbox strip; trim it back to a shape. */
const MAX_VISUAL_RATIO = 3.5;



/**
 * Trims a box to a sane picture shape, centred in the space it was given.
 *
 * The largest empty rectangle on a text-heavy slide is often a full-width
 * band an inch and a half tall. That is a legitimate hole and a terrible
 * frame: nothing worth drawing is 8:1, so the model either crops its subject
 * to nothing or fills the strip with clutter. Narrowing it to 3.5:1 and
 * leaving the remainder as whitespace is the better trade.
 */
function shapely(box: Box): Box {
  const ratio = box.w / box.h;

  if (ratio > MAX_VISUAL_RATIO) {
    const width = box.h * MAX_VISUAL_RATIO;
    return { ...box, x: box.x + (box.w - width) / 2, w: width };
  }

  if (ratio < 1 / MAX_VISUAL_RATIO) {
    const height = box.w * MAX_VISUAL_RATIO;
    return { ...box, y: box.y + (box.h - height) / 2, h: height };
  }

  return box;
}

/**
 * How much vertical room an element's own text needs, in inches, at real
 * font metrics — a bulleted list is measured line by line rather than as one
 * joined blob, because that is what actually stacks on the slide: each
 * item wraps on its own and the items are separated by the deck's paragraph
 * gap, not by nothing.
 */
function contentHeight(
  font: NonNullable<Awaited<ReturnType<typeof loadFont>>>,
  element: Pick<SlideElement, 'text' | 'items'>,
  widthInches: number,
  fontSizePt: number,
  paragraphGapIn: number,
): number {
  if (element.items?.length) {
    const lines = element.items.reduce(
      (total, item) => total + measuredHeight(font, item, widthInches, fontSizePt),
      0,
    );
    return lines + paragraphGapIn * (element.items.length - 1);
  }
  if (element.text) return measuredHeight(font, element.text, widthInches, fontSizePt);
  return 0;
}

/** The theme size an element's semantic role is drawn at. Mirrors `sizeForRole`. */
function themeSizeFor(role: string, theme: ReturnType<typeof themeFromStyleSpec>): number {
  if (role === 'title') return theme.sizes.title;
  if (role === 'subtitle') return theme.sizes.subtitle;
  if (role === 'caption' || role === 'label') return theme.sizes.caption;
  return theme.sizes.body;
}

/**
 * Roughly how tall an element's own copy is, in inches, before any font has
 * been measured.
 *
 * Used only to decide how a shared slot is divided between the elements that
 * claimed it — a one-line heading over a four-line list should not take half
 * the column. `applyLayouts` runs long before `fitTypeToBoxes` loads the real
 * .ttf, so this is the estimate from ./pptx/theme rather than glyph metrics.
 * Being a few percent out only shifts a boundary; the property that matters —
 * that the boxes do not overlap — comes from `stackInSlot` either way.
 */
function elementTextHeight(
  element: SlideElement,
  widthInches: number,
  theme: ReturnType<typeof themeFromStyleSpec>,
): number {
  const size = themeSizeFor(element.role, theme);
  const lineHeight = (size * 1.2) / 72;

  if (element.items?.length) {
    return (
      element.items.reduce(
        (total, item) => total + estimateTextHeight(item, widthInches, size),
        0,
      ) +
      theme.spacing.paragraphGap * (element.items.length - 1)
    );
  }

  if (element.text) return estimateTextHeight(element.text, widthInches, size);
  return lineHeight;
}

/**
 * What an auto-added picture should show.
 *
 * The slide's own key message, framed as a request for a depiction rather than
 * an illustration of a sentence — a model handed a bare claim tends to reach
 * for a diagram with labels on it, which is the one thing these images must
 * not have. Falls back to the slide's title when the plan has no entry.
 */
function subjectFor(slide: SlideSpec, keyMessage: string | undefined): string {
  const idea = keyMessage ?? slide.title ?? slide.subtitle;

  return idea
    ? `A visual depiction of this idea, using objects and scenery rather than any diagram or label: ${idea}`
    : 'An abstract composition in the deck’s visual language.';
}

/**
 * Where an element sits in the entrance cascade.
 *
 * The same order `layer()` draws in, and for the same reason: a caption should
 * not arrive before the card it labels. Kept as its own function rather than
 * imported from the builder because that one ranks stored blocks and this one
 * ranks pipeline elements — same rule, two shapes.
 */
function motionRank(type: string): number {
  if (type === 'image') return 0;
  if (type === 'card' || type === 'shape') return 1;
  return 2;
}

/** Two decimal places. A delay of 0.12000000000000001 is a delay of 0.12. */
function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

export type ProgressListener = (status: AgentState['status'], message: string) => void;

export class Manager {
  private readonly runId: string;
  private readonly memory: Memory;
  private state: AgentState;
  private readonly onProgress?: ProgressListener;
  private readonly imageDir: string;
  private readonly targetSlideCount?: number;
  private imagePaths: string[] = [];
  /** Fonts do not change between revisions, so they are chosen once. */
  private fontsCurated = false;
  /** A chosen template, if the deck has one. See `ManagerInput.stylePreset`. */
  private readonly stylePreset?: StyleSpec;

  constructor(input: ManagerInput, onProgress?: ProgressListener) {
    this.runId = input.runId ?? randomUUID();
    this.memory = openMemory(this.runId, input.onLog);
    this.onProgress = onProgress;
    this.imageDir = input.imageDir ?? path.join(process.cwd(), 'generated', 'images');
    this.targetSlideCount = input.targetSlideCount;
    this.stylePreset = input.stylePreset;
    this.state = {
      userRequest: input.userRequest,
      sourceFiles: input.sourceFiles ?? [],
      styleReference: input.styleReference,
      revisionCount: 0,
      status: 'idle',
    };

    this.memory.note(MEMORY_KEYS.brief, input.userRequest);
  }

  private setStatus(status: AgentState['status'], message: string) {
    this.state.status = status;
    this.memory.enter(status);
    this.memory.step(message);
    this.onProgress?.(status, message);
  }

  /**
   * Loads a specialist and returns the two things a call needs: its prompt and
   * the model it runs on. A skill picks its own model with a `model:` line in
   * its frontmatter; without one it falls back to `OPENROUTER_MODEL`.
   */
  private async specialist(skill: string): Promise<{ systemPrompt: string; model?: string }> {
    const loaded = await loadSkill(skill);
    return { systemPrompt: loaded.systemPrompt, model: loaded.model };
  }

  /**
   * What earlier stages established, for a later stage's prompt.
   *
   * This is the mechanism by which the specialists "talk": none of them shares
   * a conversation, so continuity is a paragraph of shared memory pasted into
   * each prompt rather than a chat history nobody could afford to carry.
   */
  private context(...keys: string[]): string {
    return this.memory.digest(keys);
  }

  /**
   * Runs a second-opinion critique of a draft specialist's output on a
   * different model, and revises once if the critic did not approve it.
   *
   * Deliberately not the QA loop's shape (see `review()`/`assemble()`): none
   * of the stages this is used for has a code-computed fact for a critic's
   * opinion to be checked against, so a second or third round has nothing to
   * converge on that one revision didn't already have. One critique, one
   * revision if requested, done — matching `revisePlan()`'s existing one-shot
   * precedent.
   *
   * Never throws: a critic or revision that fails to run leaves the original
   * output standing. A second opinion is a quality improvement, not a
   * dependency the pipeline cannot survive losing.
   */
  private async critiqueAndRevise<T>(params: {
    criticSkill: string;
    criticStage: string;
    current: T;
    criticPrompt: (current: T) => string;
    criticImages?: string[];
    reviseFn: (critique: Critique) => Promise<T>;
  }): Promise<T> {
    const { criticSkill, criticStage, current, criticPrompt, criticImages, reviseFn } = params;

    let critique: Critique;
    try {
      const critic = await this.specialist(criticSkill);
      critique = await generateStructured({
        ...critic,
        userPrompt: criticPrompt(current),
        images: criticImages,
        schema: critiqueSchema,
        stage: criticStage,
      });
    } catch (error) {
      this.memory.error(
        `${criticStage} failed to run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return current;
    }

    if (critique.approved || critique.issues.length === 0) {
      this.memory.step(`${criticStage} approved`, { issues: critique.issues.length });
      return current;
    }

    this.memory.step(`${criticStage} requested changes`, {
      issues: critique.issues.length,
      major: critique.issues.filter((i) => i.severity === 'major').length,
    });

    try {
      const revised = await reviseFn(critique);
      this.memory.result(`${criticStage} revision applied`, {});
      return revised;
    } catch (error) {
      this.memory.error(
        `Revision after ${criticStage} failed, keeping the original: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return current;
    }
  }

  // ── 1. Research ────────────────────────────────────────────────────────────

  /**
   * Reads whatever documents the caller supplied.
   *
   * Failures are per-file and never fatal: four documents that parsed and one
   * that did not is a narrower brief, not a dead build. The one that did not
   * is named, so the gap is visible in the trace.
   */
  private async readSourceDocuments(): Promise<ReadDocumentOutput[]> {
    const documents: ReadDocumentOutput[] = [];

    for (const filePath of this.state.sourceFiles) {
      try {
        const document = await readDocument.execute({ filePath });

        if (document.format === 'unsupported' || !document.text.trim()) {
          this.memory.error(`No text could be extracted from ${document.name}`, {
            format: document.format,
          });
          continue;
        }

        this.memory.step(`Read ${document.name}`, {
          format: document.format,
          chars: document.text.length,
          pages: document.pages,
          truncated: document.truncated,
        });
        documents.push(document);
      } catch (error) {
        this.memory.error(
          `Could not read ${path.basename(filePath)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return documents;
  }

  /** Packs document text into the Researcher's prompt within a fixed budget. */
  private renderDocuments(documents: ReadDocumentOutput[]): string {
    if (documents.length === 0) return '';

    const share = Math.floor(RESEARCH_CONTEXT_CHARS / documents.length);

    return documents
      .map((document) => {
        const body = document.text.slice(0, share);
        const clipped = body.length < document.text.length || document.truncated;

        return [
          `### ${document.name}${clipped ? ' (truncated)' : ''}`,
          body,
        ].join('\n');
      })
      .join('\n\n');
  }

  /**
   * Establishes what the deck is allowed to say.
   *
   * Documents first, because a supplied source outranks anything found on the
   * web. With no documents the call is made with live search attached — that
   * is the "if there is nothing to read, go and look" branch, and it is the
   * common one, since most decks are requested from a topic and nothing else.
   *
   * With neither, the brief comes from the model's own knowledge and says so,
   * which is honest and still usable for a settled topic.
   */
  private async research(): Promise<ResearchBrief> {
    this.setStatus('researching', 'Researching the topic...');

    const documents = await this.readSourceDocuments();
    const searching = documents.length === 0 && serverEnv.webSearchEnabled;

    this.memory.step(
      documents.length > 0
        ? `Working from ${documents.length} supplied document${documents.length === 1 ? '' : 's'}`
        : searching
          ? `No documents supplied — searching the web (${serverEnv.webSearchEngine})`
          : 'No documents and web search is disabled — relying on the model’s own knowledge',
    );

    const researcher = await this.specialist('researcher');

    let brief = await generateStructured({
      ...researcher,
      userPrompt: [
        this.context(MEMORY_KEYS.brief),
        `Request: ${this.state.userRequest}`,
        this.targetSlideCount
          ? `The deck is about ${this.targetSlideCount} slides, so aim for roughly ${
              this.targetSlideCount * 3
            } findings.`
          : 'Aim for two to three findings per slide the deck is likely to need.',
        documents.length > 0
          ? [
              'Source documents follow. They are your primary evidence — prefer them',
              'over anything else and attribute findings to them by filename.',
              '',
              this.renderDocuments(documents),
            ].join('\n')
          : searching
            ? 'No documents were supplied. Live web results are attached to this call; use them, and cite what you take.'
            : 'No documents were supplied and web search is unavailable. Work from your own knowledge, mark those findings `model-knowledge`, and be conservative about anything that may have changed.',
        'Return a ResearchBrief as JSON.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: researchBriefSchema,
      stage: 'researcher',
      // The stage the whole deck rests on. Thinking here is the cheapest
      // thinking in the build.
      effort: 'high',
      search: searching ? { searchPrompt: this.state.userRequest } : undefined,
    });

    brief = await this.critiqueAndRevise({
      criticSkill: 'research-critic',
      criticStage: 'research-critic',
      current: brief,
      criticPrompt: (current) =>
        [
          `Request: ${this.state.userRequest}`,
          `ResearchBrief to review: ${JSON.stringify(current)}`,
          'Return a Critique as JSON.',
        ].join('\n\n'),
      reviseFn: (critique) =>
        generateStructured({
          ...researcher,
          userPrompt: [
            `Request: ${this.state.userRequest}`,
            `Your previous ResearchBrief: ${JSON.stringify(brief)}`,
            `A second-opinion review found: ${JSON.stringify(critique.issues)}`,
            documents.length > 0
              ? ['Source documents follow, unchanged:', '', this.renderDocuments(documents)].join(
                  '\n',
                )
              : '',
            'Return a corrected, COMPLETE ResearchBrief as JSON.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          schema: researchBriefSchema,
          stage: 'researcher',
          effort: 'high',
          search: searching ? { searchPrompt: this.state.userRequest } : undefined,
        }),
    });

    // The digest, not the whole brief: later stages get the full object when
    // they need it, and a prompt that carries every finding twice is waste.
    this.memory.note(MEMORY_KEYS.research, {
      summary: brief.summary,
      findings: brief.findings.length,
      highConfidence: brief.findings.filter((f) => f.confidence === 'high').length,
      keyTerms: brief.keyTerms,
      openQuestions: brief.openQuestions,
    });

    this.memory.result('Research brief built', {
      findings: brief.findings.length,
      sources: brief.sources.length,
      openQuestions: brief.openQuestions.length,
    });
    this.memory.handoff(
      'researcher',
      'content-planner',
      `${brief.findings.length} findings from ${brief.sources.length} source(s)`,
    );

    return brief;
  }

  // ── 2. Outline ─────────────────────────────────────────────────────────────

  /**
   * Repairs the plan's structure before anything is built on it.
   *
   * Three things are enforced in code rather than argued about in a retry: the
   * slides are numbered in order, every word budget sits at or under the
   * deck's ceiling, and the deck opens and closes. The last one matters most —
   * a planner that returns twelve `body` slides has produced a list of facts,
   * and a deck that starts mid-thought and stops mid-thought is the most
   * common way a generated presentation reads as generated.
   */
  private normalisePlan(plan: ContentPlan): ContentPlan {
    const ceiling = plan.maxWordsPerSlide;

    const slides = plan.slides
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((slide, index) => ({
        ...slide,
        number: index + 1,
        // The planner's own budget wins while it is inside the ceiling it set.
        wordBudget: Math.min(slide.wordBudget, ceiling),
      }));

    const hasIntro = slides.some((slide) => slide.section === 'intro');
    const hasConclusion = slides.some((slide) => slide.section === 'conclusion');

    if (!hasIntro && slides.length > 0) {
      slides[0] = { ...slides[0], section: 'intro' };
      this.memory.step('Plan had no opening — first slide marked as the intro');
    }

    if (!hasConclusion && slides.length > 1) {
      const last = slides.length - 1;
      slides[last] = { ...slides[last], section: 'conclusion' };
      this.memory.step('Plan had no close — last slide marked as the conclusion');
    }

    // A title slide with a paragraph on it is a title slide that failed.
    const withTitleBudget = slides.map((slide, index) =>
      index === 0 && slide.section === 'intro'
        ? { ...slide, wordBudget: Math.min(slide.wordBudget, TITLE_WORD_BUDGET) }
        : slide,
    );

    return { ...plan, slides: withTitleBudget };
  }

  private async planContent(brief: ResearchBrief): Promise<ContentPlan> {
    this.setStatus('planning', 'Planning slides...');

    const contentPlanner = await this.specialist('content-planner');

    const raw = await generateStructured({
      ...contentPlanner,
      userPrompt: [
        this.context(MEMORY_KEYS.brief, MEMORY_KEYS.research),
        `Request: ${this.state.userRequest}`,
        this.targetSlideCount
          ? `The user asked for about ${this.targetSlideCount} slides. Treat that as a target, not a quota — do not pad.`
          : '',
        `ResearchBrief (the only facts this deck may state): ${JSON.stringify(brief)}`,
        'Sequence these findings into a deck that opens and closes properly.',
        `Set maxWordsPerSlide and a per-slide wordBudget; ${DEFAULT_WORD_BUDGET} is a reasonable default ceiling.`,
        'Return a ContentPlan as JSON.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: contentPlanSchema,
      stage: 'content-planner',
    });

    let plan = this.normalisePlan(raw);

    plan = this.normalisePlan(
      await this.critiqueAndRevise({
        criticSkill: 'plan-critic',
        criticStage: 'plan-critic',
        current: plan,
        criticPrompt: (current) =>
          [
            `Request: ${this.state.userRequest}`,
            `ResearchBrief this plan must stay inside: ${JSON.stringify(brief)}`,
            `ContentPlan to review: ${JSON.stringify(current)}`,
            'Return a Critique as JSON.',
          ].join('\n\n'),
        reviseFn: (critique) =>
          generateStructured({
            ...contentPlanner,
            userPrompt: [
              `Request: ${this.state.userRequest}`,
              `ResearchBrief (the only facts this deck may state): ${JSON.stringify(brief)}`,
              `Your previous ContentPlan: ${JSON.stringify(plan)}`,
              `A second-opinion review found: ${JSON.stringify(critique.issues)}`,
              'Return the COMPLETE revised ContentPlan as JSON.',
            ].join('\n\n'),
            schema: contentPlanSchema,
            stage: 'content-planner',
          }),
      }),
    );

    this.memory.note(MEMORY_KEYS.outline, {
      title: plan.title,
      objective: plan.objective,
      audience: plan.audience,
      maxWordsPerSlide: plan.maxWordsPerSlide,
      slides: plan.slides.map((slide) => ({
        number: slide.number,
        section: slide.section,
        keyMessage: slide.keyMessage,
        wordBudget: slide.wordBudget,
      })),
    });

    this.memory.result('Content plan built', {
      slides: plan.slides.length,
      intro: plan.slides.filter((s) => s.section === 'intro').length,
      body: plan.slides.filter((s) => s.section === 'body').length,
      conclusion: plan.slides.filter((s) => s.section === 'conclusion').length,
      maxWordsPerSlide: plan.maxWordsPerSlide,
    });
    this.memory.handoff(
      'content-planner',
      'style-analyzer',
      `${plan.slides.length} slides planned, ${plan.maxWordsPerSlide} words max each`,
    );

    return plan;
  }

  // ── 3. Style ───────────────────────────────────────────────────────────────

  private async analyzeStyle(): Promise<StyleSpec> {
    // A chosen template already IS the answer this stage exists to produce, so
    // there is nothing to analyze, nothing to critique, and no image to send.
    // The canvas is still fixed in code, exactly as it is for an analyzed spec.
    if (this.stylePreset) {
      this.setStatus('analyzing-style', 'Applying the chosen template...');

      const aspectRatio: SlideAspectRatio =
        this.stylePreset.slideSize.aspectRatio === 'custom'
          ? '16:9'
          : this.stylePreset.slideSize.aspectRatio;

      const spec: StyleSpec = {
        ...this.stylePreset,
        slideSize: { ...SLIDE_SIZES[aspectRatio], aspectRatio },
      };

      this.memory.note(MEMORY_KEYS.style, {
        template: spec.source.path,
        visualLanguage: spec.visualLanguage,
        colors: spec.colors,
        slideSize: spec.slideSize,
        layoutPrinciples: spec.layoutPrinciples,
      });
      this.memory.result('Template applied', { template: spec.source.path });
      this.memory.handoff(
        'style-analyzer',
        'slide-designer',
        `template "${spec.source.path}" — no vision call needed`,
      );

      return spec;
    }

    const reference = this.state.styleReference;

    if (!reference) {
      throw new AgentError(
        'A style reference image or a template is required — the deck has no visual source of truth without one.',
        'STYLE_REFERENCE_MISSING',
        'style-analyzer',
      );
    }

    this.setStatus('analyzing-style', 'Analyzing style reference...');

    // Measure first, interpret second: the model never guesses at numbers the
    // image can be asked for directly.
    const measured = await analyzeStyleImage.execute({ imagePath: reference.imagePath });
    const imageDataUrl = await readStyleImageAsDataUrl(reference.imagePath);

    // The canvas is decided here, not by the model — see SLIDE_SIZES.
    const aspectRatio: SlideAspectRatio =
      measured.aspectRatio === 'custom' ? '16:9' : measured.aspectRatio;
    const slideSize = { ...SLIDE_SIZES[aspectRatio], aspectRatio };

    const styleAnalyzer = await this.specialist('style-analyzer');

    let spec = await generateStructured({
      // The one stage that must actually look at the reference; every other
      // specialist works from its output. The skill's own `model:` wins if it
      // declares one.
      model: styleAnalyzer.model ?? serverEnv.openRouterVisionModel,
      images: [imageDataUrl],
      systemPrompt: [
        styleAnalyzer.systemPrompt,
        'You are being called in single-shot mode: the reference image is attached to this',
        'message and there are no tools to call. Return the StyleSpec JSON object directly.',
        'Describe only the design system you can see — palette, type hierarchy, spacing rhythm,',
        'shape and image treatment. Never describe the image’s subject matter, and never',
        'suggest reusing the image itself.',
      ].join('\n'),
      userPrompt: [
        `Measured facts (authoritative — do not contradict): ${JSON.stringify(measured)}`,
        'Return a complete StyleSpec as JSON. Font sizes in points, spacing in inches.',
        // The schema coerces both of these, but saying so costs one line and
        // saves a retry on most builds.
        'Every measurement is a bare number — 44, not "44pt". Font weights are',
        'numbers on the CSS scale (400 regular, 700 bold), not words.',
        'spacing needs all four of outerMargin, sectionGap, elementGap, paragraphGap.',
        `Set source to ${JSON.stringify({ type: 'image', path: reference.imagePath })}`,
        `and slideSize to exactly ${JSON.stringify(slideSize)}.`,
        'Every colour must be a #rrggbb hex you can point to in the image.',
        'visualLanguage is read verbatim into every image-generation prompt in this',
        'deck, so write it as a usable art direction — medium, finish, level of',
        'detail, lighting — not as an adjective.',
      ].join('\n'),
      schema: styleSpecSchema,
      stage: 'style-analyzer',
    });

    // Belt and braces: the two fields we already know are overwritten rather
    // than trusted, so a drifting model cannot resize the deck.
    spec.slideSize = slideSize;
    spec.source = { type: 'image', path: reference.imagePath };

    spec = await this.critiqueAndRevise({
      criticSkill: 'style-critic',
      criticStage: 'style-critic',
      current: spec,
      criticImages: [imageDataUrl],
      criticPrompt: (current) =>
        [
          `Measured facts: ${JSON.stringify(measured)}`,
          `StyleSpec to review against the attached reference image: ${JSON.stringify(current)}`,
          'Return a Critique as JSON.',
        ].join('\n\n'),
      reviseFn: async (critique) => {
        const revised = await generateStructured({
          model: styleAnalyzer.model ?? serverEnv.openRouterVisionModel,
          images: [imageDataUrl],
          systemPrompt: styleAnalyzer.systemPrompt,
          userPrompt: [
            `Measured facts (authoritative — do not contradict): ${JSON.stringify(measured)}`,
            `Your previous StyleSpec: ${JSON.stringify(spec)}`,
            `A second-opinion review found: ${JSON.stringify(critique.issues)}`,
            `Set source to ${JSON.stringify({ type: 'image', path: reference.imagePath })}`,
            `and slideSize to exactly ${JSON.stringify(slideSize)}.`,
            'Return a corrected, COMPLETE StyleSpec as JSON.',
          ].join('\n\n'),
          schema: styleSpecSchema,
          stage: 'style-analyzer',
        });
        revised.slideSize = slideSize;
        revised.source = { type: 'image', path: reference.imagePath };
        return revised;
      },
    });

    this.memory.note(MEMORY_KEYS.style, {
      visualLanguage: spec.visualLanguage,
      colors: spec.colors,
      slideSize: spec.slideSize,
      layoutPrinciples: spec.layoutPrinciples,
    });

    this.memory.result('StyleSpec derived', { visualLanguage: spec.visualLanguage });
    this.memory.handoff(
      'style-analyzer',
      'slide-designer',
      `${spec.slideSize.aspectRatio} canvas, palette of ${
        Object.values(spec.colors).filter(Boolean).length
      }`,
    );

    return spec;
  }

  // ── 4. Write ───────────────────────────────────────────────────────────────

  private async designSlides(
    plan: ContentPlan,
    styleSpec: StyleSpec,
    feedback?: QAReport,
  ): Promise<SlideSpec[]> {
    this.setStatus(feedback ? 'revising' : 'designing', 'Writing and designing slides...');

    const slideDesigner = await this.specialist('slide-designer');
    const { slides } = await generateStructured({
      ...slideDesigner,
      userPrompt: [
        this.context(MEMORY_KEYS.brief, MEMORY_KEYS.research, MEMORY_KEYS.outline),
        `ContentPlan: ${JSON.stringify(plan)}`,
        `StyleSpec: ${JSON.stringify(styleSpec)}`,
        `Slide canvas: ${styleSpec.slideSize.width}in x ${styleSpec.slideSize.height}in.`,
        'All element boxes are in inches and must sit fully inside the canvas.',
        // Restated as a list because it is the constraint most likely to be
        // read once at the top of a long plan and then forgotten by slide nine.
        [
          'Word budgets. These count ALL visible copy on a slide — title,',
          'subtitle, every text element, every card (speaker notes are free) —',
          'and they are a RANGE, not just a ceiling. Aim for 60-90% of each.',
          'Under half is reported back as an under-written slide, because that',
          'is what a slide of bare labels measures as.',
          '',
          ...plan.slides.map(
            (slide) =>
              `  slide ${slide.number} (${slide.section}): ${Math.round(
                slide.wordBudget * 0.6,
              )}-${slide.wordBudget} words`,
          ),
          '',
          'Write points, not labels. "Following a recipe" names a topic; ',
          '"Following a recipe — steps in a fixed order, each depending on the',
          'last" is a point. Every card and bullet should carry the thing AND',
          'what makes it matter, in 6-14 words.',
          '',
          'Two or three bullets per slide, never more. The reader is looking at',
          'a slide, not reading a page: the picture carries the idea and the',
          'words name it. A fourth bullet is almost always the first sentence of',
          'the speaker notes, which are free and are where it belongs.',
        ].join('\n'),
        // The designer describes; the Illustrator generates. Asking a model for
        // a path only ever produced a plausible filename that does not exist.
        [
          'LAYOUT. Give every slide an `archetype` from this list, and give every',
          "element a `slot` that archetype provides. The pipeline computes each",
          "slot's exact rectangle from this deck's canvas and spacing, so your",
          '`box` values are placeholders — put anything plausible in them.',
          'Choosing the right composition is your job; the arithmetic is not.',
          '',
          ...LAYOUT_ARCHETYPES.map((name) => `  ${name} — ${ARCHETYPE_GUIDE[name]}`),
          '',
          'Vary them. A deck where every slide is hero-right is a deck that was',
          'not designed. Open with title-hero or title-only; reach for quote or',
          'stat-row when the content genuinely is a quote or three numbers.',
          'hero-right and hero-left are the same shape mirrored (picture right',
          'vs picture left) — alternate between them across the deck rather than',
          'defaulting to one side every time.',
          '',
          'A three-column or two-column slide of ordinary bullets reads better as',
          'plain `text` elements with `items` in each col-N slot than as `card`',
          'elements: a card is boxed to the full column height by the layout, so',
          'two or three short bullets inside one leaves a visibly empty box below',
          'them. Reach for `card`/`shape` only when a boxed treatment earns its',
          'keep (a real comparison, a warning, a single number standing apart).',
          '',
          'EVERY slide must include one `image` element — no exceptions. Every',
          'archetype except title-only and quote has an `image` slot; choose one',
          'of those two only when the slide truly needs no picture.',
          'Set imagePrompt to what the picture should SHOW: concrete objects and',
          'a scene, never a topic word. No colours, palette or art style — those',
          'come from the StyleSpec and are applied identically to every image in',
          'the deck. Never set imagePath; the pipeline fills it in.',
        ].join('\n'),
        feedback
          ? [
              `Fix these QA issues from the previous attempt: ${JSON.stringify(feedback.issues)}`,
              'This is a revision, not a rewrite. The pictures already generated for',
              'this deck are being reused as-is to avoid paying for them twice — so',
              'keep every `image` element in the same place, with the same',
              '`imagePrompt`, unless an issue specifically says a picture is missing',
              'or wrong. Fix everything else — wording, word count, alignment, box',
              'geometry, colour — with text and layout changes, not new pictures.',
            ].join('\n')
          : '',
        'Return {"slides": SlideSpec[]} as JSON.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: z.object({ slides: z.array(slideSpecSchema).min(1) }),
      stage: 'slide-designer',
    });

    // Deterministic pre-flight: cheaper to catch a bad box here than after
    // building the whole deck.
    for (const slide of slides) {
      const { fits, issues } = await checkOverflow.execute({ slideSpec: slide, styleSpec });
      if (!fits) {
        this.memory.error(`Slide ${slide.slideNumber} has layout issues`, { issues });
      }
    }

    this.memory.result('Slides written', { count: slides.length });
    return slides;
  }

  /**
   * Counts the words on every slide against its budget.
   *
   * Code, not the reviewer: a model asked whether its own slide is under fifty
   * words answers yes. A small overage is a note for the next revision; a
   * large one is critical, because at that point the budget was not a
   * constraint the designer was working inside at all.
   */
  private async enforceWordBudgets(
    slideSpecs: SlideSpec[],
    plan: ContentPlan,
  ): Promise<QAReport['issues']> {
    const budgets = new Map(plan.slides.map((slide) => [slide.number, slide.wordBudget]));
    const issues: QAReport['issues'] = [];
    let overBudget = 0;
    let underBudget = 0;
    let total = 0;

    for (const slideSpec of slideSpecs) {
      const budget = budgets.get(slideSpec.slideNumber) ?? plan.maxWordsPerSlide;
      const count = await checkWordBudget.execute({ slideSpec, budget });
      total += count.words;

      if (!count.withinBudget) {
        overBudget += 1;
        const overshoot = (count.words - budget) / budget;

        issues.push({
          severity: overshoot > BUDGET_TOLERANCE ? 'critical' : 'major',
          slideNumber: slideSpec.slideNumber,
          category: 'content',
          description: `Slide ${slideSpec.slideNumber} has ${count.words} words against a budget of ${budget}.`,
          recommendation: `Cut ${count.words - budget} words, or move them into speakerNotes. Heaviest: ${count.breakdown
            .slice()
            .sort((a, b) => b.words - a.words)
            .slice(0, 2)
            .map((entry) => `${entry.role} (${entry.words})`)
            .join(', ')}.`,
        });
        continue;
      }

      // The other half of the range. A slide well under its budget has not
      // been edited down to something sharp — it has been left unfinished, and
      // it reads that way: bare labels where there should be points that say
      // something. A title slide is exempt, since being brief is its job.
      const floor = Math.round(budget * MIN_BUDGET_USE);
      const isTitleSlide = budget <= TITLE_WORD_BUDGET;

      if (!isTitleSlide && count.words < floor) {
        underBudget += 1;

        issues.push({
          severity: 'major',
          slideNumber: slideSpec.slideNumber,
          category: 'content',
          description: `Slide ${slideSpec.slideNumber} uses only ${count.words} of its ${budget}-word budget — it is under-written.`,
          recommendation:
            'Turn the bare labels into points that actually say something: what it is, and why it matters. ' +
            `There is room for roughly ${budget - count.words} more words.`,
        });
      }
    }

    this.memory.result('Word budgets checked', {
      slides: slideSpecs.length,
      overBudget,
      underBudget,
      totalWords: total,
    });

    return issues;
  }

  // ── 5. Illustrate ──────────────────────────────────────────────────────────

  /**
   * Decides which slides get a generated backdrop, then makes them.
   *
   * The agent supplies judgement — WHERE a backdrop helps and what it depicts.
   * `generate_image` supplies the pixels, from the same locked style block as
   * every other image in the deck. Backdrops are rendered at full slide size
   * and dimmed toward the background colour so text stays readable.
   *
   * Never fatal: a deck with plain colour behind its title slide is a deck.
   */
  private async designBackgrounds(
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
    /** Slides too full for an illustration. These get a backdrop regardless. */
    required: Set<number> = new Set(),
  ): Promise<SlideSpec[]> {
    this.setStatus('illustrating', 'Designing backgrounds...');

    const backgroundDesigner = await this.specialist('background-designer');

    let plan: BackgroundPlan;
    try {
      plan = await generateStructured({
        ...backgroundDesigner,
        userPrompt: [
          this.context(MEMORY_KEYS.outline, MEMORY_KEYS.style),
          `Slides: ${JSON.stringify(
            slideSpecs.map((slide) => ({
              slideNumber: slide.slideNumber,
              layout: slide.layout,
              title: slide.title,
              textLength: slide.elements
                .filter((element) => element.type === 'text')
                .reduce(
                  (length, element) =>
                    length + (element.text?.length ?? 0) + (element.items?.join(' ').length ?? 0),
                  0,
                ),
            })),
          )}`,
          `Visual language: ${styleSpec.visualLanguage}`,
          `Layout principles: ${JSON.stringify(styleSpec.layoutPrinciples)}`,
          'Return a BackgroundPlan. Most slides should NOT be listed.',
        ].join('\n\n'),
        schema: backgroundPlanSchema,
        stage: 'background-designer',
      });

      // Critiqued before any image is generated from it, on purpose: images
      // are ~90% of a deck's bill, so a flawed plan must be caught here, not
      // after paying for pictures built from it.
      plan = await this.critiqueAndRevise({
        criticSkill: 'background-critic',
        criticStage: 'background-critic',
        current: plan,
        criticPrompt: (current) =>
          [
            `Visual language: ${styleSpec.visualLanguage}`,
            `Layout principles: ${JSON.stringify(styleSpec.layoutPrinciples)}`,
            `Slides: ${JSON.stringify(
              slideSpecs.map((slide) => ({ slideNumber: slide.slideNumber, layout: slide.layout })),
            )}`,
            `BackgroundPlan to review: ${JSON.stringify(current)}`,
            'This plan is about to be spent on real image generation — flag anything wrong before it is.',
            'Return a Critique as JSON.',
          ].join('\n\n'),
        reviseFn: (critique) =>
          generateStructured({
            ...backgroundDesigner,
            userPrompt: [
              this.context(MEMORY_KEYS.outline, MEMORY_KEYS.style),
              `Your previous BackgroundPlan: ${JSON.stringify(plan)}`,
              `A second-opinion review found: ${JSON.stringify(critique.issues)}`,
              'Return the COMPLETE corrected BackgroundPlan as JSON.',
            ].join('\n\n'),
            schema: backgroundPlanSchema,
            stage: 'background-designer',
          }),
      });
    } catch (error) {
      // A deck without backdrops is fine; a deck that died choosing them is not
      // — except for the slides that have no other visual, which still get one
      // from the fallback below.
      this.memory.error(
        `Background planning skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      plan = { backgrounds: [] };
    }

    const wanted = new Map(
      plan.backgrounds.map((entry) => [
        entry.slideNumber,
        { ...entry, dim: Math.max(entry.dim, MIN_BACKDROP_DIM) },
      ]),
    );

    // A slide with no room for an illustration has no other way to carry a
    // picture, so the designer's judgement about whether it "needs" one is not
    // the question being asked. Anything it already planned wins; the rest get
    // a quiet backdrop derived from the slide itself.
    const byNumber = new Map(slideSpecs.map((slide) => [slide.slideNumber, slide]));
    for (const slideNumber of required) {
      if (wanted.has(slideNumber)) continue;

      const slide = byNumber.get(slideNumber);
      if (!slide) continue;

      wanted.set(slideNumber, {
        slideNumber,
        prompt: `A calm, uncluttered backdrop evoking: ${
          slide.title ?? slide.subtitle ?? styleSpec.visualLanguage
        }`,
        // Heavier still than the floor: this sits behind a slide that was too
        // full for a picture, so the copy over it needs all the contrast it
        // can get.
        dim: 0.65,
        rationale: 'No room for an illustration on this slide',
      });
    }

    if (wanted.size === 0) {
      this.memory.result('No generated backgrounds needed', {});
      return slideSpecs;
    }

    const size = {
      width: Math.round(styleSpec.slideSize.width * 144),
      height: Math.round(styleSpec.slideSize.height * 144),
    };

    let made = 0;
    const withBackgrounds = await Promise.all(
      slideSpecs.map(async (slide) => {
        const entry = wanted.get(slide.slideNumber);
        if (!entry) return slide;

        try {
          const image = await generateImageTool.execute({
            prompt: entry.prompt,
            size,
            styleSpec,
            context: [slide.title, slide.subtitle].filter(Boolean).join(' · '),
            role: 'background',
          });

          const file = path.join(this.imageDir, `background-${slide.slideNumber}.png`);
          await mkdir(this.imageDir, { recursive: true });
          await writeFile(file, Buffer.from(image.base64, 'base64'));

          this.imagePaths = [...this.imagePaths, file];
          made += 1;

          return { ...slide, background: { ...entry, imagePath: file } };
        } catch (error) {
          this.memory.error(
            `Background for slide ${slide.slideNumber} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return slide;
        }
      }),
    );

    this.memory.result('Backgrounds generated', { planned: wanted.size, made });
    return withBackgrounds;
  }

  /**
   * Reuses a revision's pictures rather than paying to generate them again.
   *
   * A revision round exists to fix what QA flagged — wording, word count,
   * geometry, colour — none of which needs a new picture. So before a revised
   * slide reaches `designBackgrounds`/`illustrate`, every image element and
   * background it carries over from the *previous* round's finished slide
   * (matched by slide number, then in the order each kind of image appears)
   * gets that element's already-generated `imagePath` back. `illustrate` only
   * generates for an element that still has none, so a slide left untouched
   * by the revision, or one whose picture was never flagged, costs nothing
   * the second time — only a slide missing a picture, or one QA specifically
   * called wrong, generates a new one.
   */
  private carryForwardImages(slideSpecs: SlideSpec[], previous: SlideSpec[]): SlideSpec[] {
    const byNumber = new Map(previous.map((slide) => [slide.slideNumber, slide]));
    let reused = 0;

    const carried = slideSpecs.map((slide) => {
      const prior = byNumber.get(slide.slideNumber);
      if (!prior) return slide;

      const priorImages = prior.elements.filter(
        (element) => element.type === 'image' && element.imagePath,
      );
      let next = 0;

      const elements = slide.elements.map((element) => {
        if (element.type !== 'image' || element.imagePath) return element;

        const match = priorImages[next];
        if (!match) return element;

        next += 1;
        reused += 1;
        return { ...element, imagePath: match.imagePath, imagePrompt: match.imagePrompt };
      });

      const reuseBackground = !slide.background?.imagePath && prior.background?.imagePath;
      if (reuseBackground) reused += 1;

      return {
        ...slide,
        elements,
        background: reuseBackground ? prior.background : slide.background,
      };
    });

    if (reused > 0) this.memory.step(`Reused ${reused} image(s) from the previous attempt`);
    return carried;
  }

  /**
   * Every local image file a deck's finished slides actually reference.
   *
   * The source of truth for what gets uploaded — not an accumulator kept
   * across the revision loop, which would either miss a carried-forward
   * image (never generated this round, so never appended) or hold a path
   * that a revision has since dropped. Reading it off the slides themselves
   * is correct regardless of which round produced which picture.
   */
  private collectImagePaths(slideSpecs: SlideSpec[]): string[] {
    const paths = new Set<string>();
    for (const slide of slideSpecs) {
      if (slide.background?.imagePath) paths.add(slide.background.imagePath);
      for (const element of slide.elements) {
        if (element.type === 'image' && element.imagePath) paths.add(element.imagePath);
      }
    }
    return [...paths];
  }

  /**
   * Turns every `image` element's description into an actual picture.
   *
   * Runs between design and build because the builder needs a file on disk,
   * and the designer is the one who knows what the picture is for. Failures are
   * reported, never thrown: a deck missing one illustration still ships.
   */
  private async illustrate(slideSpecs: SlideSpec[], styleSpec: StyleSpec): Promise<SlideSpec[]> {
    const wanted = slideSpecs.reduce(
      (count, slide) =>
        count + slide.elements.filter((e) => e.type === 'image' && !e.imagePath).length,
      0,
    );

    if (wanted === 0) {
      this.memory.step('No new images needed');
      return slideSpecs;
    }

    this.setStatus('illustrating', `Generating ${wanted} image${wanted === 1 ? '' : 's'}...`);

    const result = await illustrateSlides(
      slideSpecs,
      styleSpec,
      this.imageDir,
      (done, total) => this.memory.step(`Image ${done} of ${total}`),
    );

    // Appended, not assigned: the backdrops generated a moment ago are in this
    // list too, and the caller uploads whatever is in it.
    this.imagePaths = [...this.imagePaths, ...result.generated];

    for (const failure of result.failures) this.memory.error(failure);
    this.memory.result('Images generated', {
      generated: result.generated.length,
      failed: result.failures.length,
    });

    return result.slideSpecs;
  }

  /**
   * Replaces every slotted element's box with the one its layout assigns.
   *
   * This is where the pipeline stops asking a model for coordinates. The
   * designer picks an archetype — which composition suits this content, a
   * judgement — and `slotsFor` computes the rectangles from it and the deck's
   * own canvas, margins and type sizes. Two slides with the same archetype in
   * decks built from different reference images get different geometry; what
   * they share is that neither has overlapping boxes, because the arithmetic
   * was done by arithmetic.
   *
   * Slides without an archetype keep the designer's boxes. The rest of the
   * pipeline — `fitToCanvas`, `growTextBoxes`, `ensureSlideVisuals` — still
   * runs over both kinds, and simply finds far less to do on a slotted one.
   *
   * **More than one element may claim the same slot, and that is by design.**
   * The Slide Designer is asked to put a short sub-heading above each group of
   * bullets, so a `three-column` slide legitimately arrives with a `label` and
   * a bulleted `body` both slotted `col-1`. Giving each of them the slot's
   * rectangle drew them one on top of the other — the failure archetypes exist
   * to make impossible. `stackInSlot` divides the slot between them instead,
   * each getting the room its own text actually needs.
   */
  private applyLayouts(slideSpecs: SlideSpec[], styleSpec: StyleSpec): SlideSpec[] {
    const theme = themeFromStyleSpec(styleSpec);
    let placed = 0;
    let stacked = 0;
    let missing = 0;
    let droppedImages = 0;

    const laid = slideSpecs.map((slide) => {
      if (!slide.archetype) return slide;

      const slots = slotsFor(slide.archetype, styleSpec);

      const kept = slide.elements.filter((element) => {
        // Every slot but `image` is sized for a line or two of type. A
        // designer occasionally files a picture under `caption` or `col-2`
        // instead — the only slots left once title and body are taken — and
        // slotting it in literally would squeeze it into a caption-height
        // band the width of the slide. Drop it here and let
        // `ensureSlideVisuals` place a properly shaped picture, rather than
        // shipping a letterbox sliver.
        if (element.slot && element.type === 'image' && element.slot !== 'image') {
          droppedImages += 1;
          return false;
        }
        return true;
      });

      // Grouped before anything is positioned, because a slot's rectangle
      // belongs to everything that claimed it, not to whichever element the
      // designer happened to list first.
      const groups = new Map<LayoutSlot, SlideElement[]>();
      for (const element of kept) {
        if (!element.slot) continue;
        if (!slots[element.slot]) {
          // The designer named a slot this archetype does not have. Its own
          // box stands — an odd position beats stacking every orphaned
          // element in the same default rectangle.
          missing += 1;
          continue;
        }
        const group = groups.get(element.slot);
        if (group) group.push(element);
        else groups.set(element.slot, [element]);
      }

      const boxes = new Map<SlideElement, Box>();
      for (const [slot, group] of groups) {
        const box = slots[slot];
        if (!box) continue;

        placed += group.length;

        if (group.length === 1) {
          boxes.set(group[0], { ...box });
          continue;
        }

        stacked += group.length;
        const shares = group.map((element) => elementTextHeight(element, box.w, theme));
        const split = stackInSlot(box, shares, styleSpec.spacing.elementGap);
        group.forEach((element, index) => boxes.set(element, split[index]));
      }

      const elements = kept.map((element) => {
        const box = boxes.get(element);
        return box ? { ...element, box } : element;
      });

      return { ...slide, elements };
    });

    if (placed > 0) {
      this.memory.step(`Placed ${placed} element(s) from layout slots`, {
        archetypes: [...new Set(laid.map((slide) => slide.archetype).filter(Boolean))],
        stacked,
      });
    }
    if (missing > 0) {
      this.memory.error(`${missing} element(s) named a slot their archetype does not have`);
    }
    if (droppedImages > 0) {
      this.memory.step(`Dropped ${droppedImages} image(s) mis-slotted into a text band`, {
        hint: 'ensureSlideVisuals will place a properly shaped picture instead',
      });
    }

    return laid;
  }

  /**
   * Draws the title a slide says it has.
   *
   * `slide.title` is metadata. The builder composes a slide from `elements`
   * and nothing else — `title` reaches only the `slides` row, for the outline
   * — so a designer that fills in `title` and then forgets a matching text
   * element produces a slide with no heading on it, in the .pptx and in the
   * web renderer alike. That is not a rare slip: the field is right there, it
   * is called `title`, and filling it in feels like the job is done.
   *
   * The prompt says to add the element; this makes it true. The box is the top
   * band inside the outer margin, and a slide whose top band is already
   * occupied is left alone — a designer that put something there has its own
   * plan for the heading, and overlapping it would be worse than trusting it.
   */
  private ensureTitleElements(slideSpecs: SlideSpec[], styleSpec: StyleSpec): SlideSpec[] {
    const margin = styleSpec.spacing.outerMargin;
    const width = styleSpec.slideSize.width - margin * 2;
    // 1.6x the type size is a comfortable single line at any title size.
    const height = Math.max(0.7, (styleSpec.typography.title.size / 72) * 1.6);
    const band: Box = { x: margin, y: margin, w: width, h: height };

    let added = 0;
    let skipped = 0;

    const withTitles = slideSpecs.map((slide) => {
      const heading = slide.title?.trim();
      if (!heading) return slide;

      // Already drawn — as a title element, or as any element carrying the
      // same words under some other role.
      const drawn = slide.elements.some(
        (element) =>
          element.role === 'title' ||
          element.text?.trim() === heading ||
          element.items?.some((item) => item.trim() === heading),
      );
      if (drawn) return slide;

      if (slide.elements.some((element) => overlaps(element.box, band))) {
        skipped += 1;
        return slide;
      }

      added += 1;
      return {
        ...slide,
        elements: [
          { type: 'text' as const, role: 'title', box: { ...band }, text: heading },
          ...slide.elements,
        ],
      };
    });

    if (added > 0) this.memory.step(`Drew ${added} missing slide title(s)`);
    if (skipped > 0) {
      this.memory.error(`${skipped} slide(s) name a title with nowhere to put it`, {
        hint: 'the top band was already occupied',
      });
    }

    return withTitles;
  }

  /**
   * Gives every slide a picture.
   *
   * The Slide Designer is asked for one and mostly provides it, but "mostly"
   * is the problem: a deck where four slides are illustrated and two are walls
   * of text does not read as a designed deck, it reads as a deck that ran out
   * of budget. So the guarantee is made in code.
   *
   * Two ways to keep it, in order of preference:
   *
   * 1. **An illustration**, if the slide has real room for one. `largestFreeRect`
   *    finds the biggest genuinely empty rectangle rather than assuming the
   *    right half is free — which is true of a two-column layout and false of
   *    every other one, and being wrong means a picture on top of the body copy.
   * 2. **A backdrop**, if it does not. A full slide has no room for a picture
   *    by definition, and forcing one in would cost the layout more than the
   *    picture is worth. Marked here and generated by `designBackgrounds`.
   *
   * The subject comes from the slide's own key message, so an auto-added
   * picture is about that slide rather than about the deck's topic in general.
   */
  private ensureSlideVisuals(
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
    plan: ContentPlan,
  ): { slideSpecs: SlideSpec[]; needBackdrop: Set<number> } {
    const area = contentArea(styleSpec);
    const gap = styleSpec.spacing.elementGap;
    const messages = new Map(plan.slides.map((slide) => [slide.number, slide]));

    const needBackdrop = new Set<number>();
    let added = 0;

    const withVisuals = slideSpecs.map((slide) => {
      if (slide.elements.some((element) => element.type === 'image')) return slide;

      const free = largestFreeRect(
        area,
        slide.elements.map((element) => element.box),
        gap,
      );

      if (
        !free ||
        free.w < MIN_VISUAL_EDGE ||
        free.h < MIN_VISUAL_EDGE ||
        free.w * free.h < MIN_VISUAL_AREA
      ) {
        needBackdrop.add(slide.slideNumber);
        return slide;
      }

      added += 1;
      return {
        ...slide,
        elements: [
          ...slide.elements,
          {
            type: 'image' as const,
            role: 'illustration',
            box: shapely(free),
            imagePrompt: subjectFor(slide, messages.get(slide.slideNumber)?.keyMessage),
          },
        ],
      };
    });

    if (added > 0) this.memory.step(`Placed ${added} missing slide illustration(s)`);
    if (needBackdrop.size > 0) {
      this.memory.step(
        `${needBackdrop.size} slide(s) too full for an illustration — giving them backdrops`,
        { slides: [...needBackdrop] },
      );
    }

    return { slideSpecs: withVisuals, needBackdrop };
  }

  /**
   * Decides how every element moves when the deck is presented.
   *
   * The Slide Designer may name an `effect` and an `intensity` on any element;
   * this fills in every element it did not, and — crucially — computes the
   * **delays**, which it is never asked for. A model handed a timeline writes
   * eight elements that all start at 0.3s, or a cascade that takes four
   * seconds to finish; both are arithmetic, and arithmetic done by eye is the
   * same failure archetypes exist to prevent.
   *
   * The stagger runs in draw order (`layer` order is what the eye reads:
   * pictures, then containers, then words) and is capped at `MAX_STAGGER`, so
   * a busy slide does not become a slow one. `delay` a designer set itself is
   * kept — an author asking for a beat before the punchline knows something
   * the stagger does not.
   *
   * Every element ends up with a motion, `none` included. A stored `none` is
   * what tells the editor panel that this element was considered and left
   * still, rather than never reached.
   */
  private ensureSlideMotion(slideSpecs: SlideSpec[]): SlideSpec[] {
    let decided = 0;

    const withMotion = slideSpecs.map((slide) => {
      // Draw order, not array order: what the viewer sees arrive first should
      // be what starts first.
      const order = [...slide.elements]
        .map((element, index) => ({ element, index }))
        .sort((a, b) => motionRank(a.element.type) - motionRank(b.element.type))
        .map(({ index }) => index);

      const step = Math.min(STAGGER_STEP, MAX_STAGGER / Math.max(1, order.length - 1));

      const elements = slide.elements.map((element, index) => {
        if (element.motion) {
          // The designer had an opinion. Honour it, and only supply the timing
          // it has no way to compute.
          const staggered =
            isAnimated(element.motion) &&
            element.motion.trigger === 'enter' &&
            element.motion.delay === 0
              ? { ...element.motion, delay: round(order.indexOf(index) * step) }
              : element.motion;

          return staggered === element.motion ? element : { ...element, motion: staggered };
        }

        decided += 1;
        const house = defaultMotionFor(element.type, element.role);
        const motion: Motion = house
          ? { ...house, delay: round(order.indexOf(index) * step) }
          : motionSchema.parse({ effect: 'none' });

        return { ...element, motion };
      });

      return { ...slide, elements };
    });

    if (decided > 0) this.memory.step(`Set entrance motion on ${decided} element(s)`);

    return withMotion;
  }

  /**
   * Sets the exact type size every text element is drawn at.
   *
   * The last piece of this pipeline that was still guessing. Line count was
   * derived from a character count times a constant, and a constant is wrong
   * in both directions at once — measured against Playfair Display Bold,
   * "Algorithms Around You" averages 0.514em per character while a line of
   * capitals is far wider. Five percent of error there is the difference
   * between a heading on one line and a heading missing its last word.
   *
   * So the font is downloaded and the glyphs are measured, once per family per
   * process. The size that comes out is stored on the element, and BOTH
   * renderers draw it rather than recomputing — which is the only way the
   * .pptx and the browser can be guaranteed to break lines in the same places.
   *
   * Falls back to the estimate when the font cannot be fetched (offline, or a
   * system face Google does not host). Worse, but not broken.
   */
  private async fitTypeToBoxes(
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
  ): Promise<SlideSpec[]> {
    const theme = themeFromStyleSpec(styleSpec);

    const [heading, body] = await Promise.all([
      loadFont(theme.fonts.heading, styleSpec.typography.title.weight),
      loadFont(theme.fonts.body, styleSpec.typography.body.weight),
    ]);

    if (!heading && !body) {
      this.memory.error('Could not load either font for measuring — falling back to estimates', {
        heading: theme.fonts.heading,
        body: theme.fonts.body,
      });
      return slideSpecs;
    }

    let shrunk = 0;
    let measured = 0;
    let sanitized = 0;

    const fitted = slideSpecs.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => {
        if (element.type === 'image' || element.type === 'divider') return element;

        const lines = element.items?.length
          ? element.items
          : element.text
            ? [element.text]
            : [];
        if (lines.length === 0) return element;

        const isHeading = element.role === 'title' || element.role === 'subtitle';
        const font = (isHeading ? heading : body) ?? heading ?? body;
        if (!font) return element;

        // A chemical equation or algebraic expression is exactly the copy a
        // designer writes in real Unicode — CO₂, x², A → B — and this is the
        // one place in the pipeline that already knows which font will
        // actually draw it. Fixed here, once, so the file and the preview
        // both draw the corrected text rather than each guessing at a fix.
        const sanitizedLines = lines.map((line) => sanitizeMathText(font, line));
        if (sanitizedLines.some((line, index) => line !== lines[index])) sanitized += 1;

        const intended =
          element.role === 'title'
            ? theme.sizes.title
            : element.role === 'subtitle'
              ? theme.sizes.subtitle
              : element.role === 'caption' || element.role === 'label'
                ? theme.sizes.caption
                : theme.sizes.body;

        // Cards inset their text; measure against what is left, not the box.
        const inset = element.type === 'card' || element.type === 'shape' ? 0.17 : 0;
        const box = {
          w: Math.max(0.1, element.box.w - inset * 2),
          h: Math.max(0.1, element.box.h - inset * 2),
        };

        const size = fitFontSize(font, sanitizedLines, box, intended);
        measured += 1;
        if (size < intended) shrunk += 1;

        return {
          ...element,
          fontSize: size,
          ...(element.items?.length
            ? { items: sanitizedLines }
            : { text: sanitizedLines[0] }),
        };
      }),
    }));

    if (sanitized > 0) {
      this.memory.step(`Replaced ${sanitized} unsupported math/chemistry glyph(s)`);
    }

    this.memory.result('Type measured against the real fonts', {
      elements: measured,
      shrunk,
      heading: heading ? theme.fonts.heading : 'estimated',
      body: body ? theme.fonts.body : 'estimated',
    });

    const withTitleBand = this.compactTitleBand(fitted, styleSpec, heading);
    return this.compactColumnCards(withTitleBand, styleSpec, body ?? heading);
  }

  /**
   * Closes the gap under a heading that turned out to be one line.
   *
   * A layout slot has to be sized before anyone knows what will go in it, so
   * `slotsFor` reserves two lines for every title — anything less would clip
   * the ones that wrap. On a deck whose titles mostly fit on one line that
   * leaves a band of dead space under each of them, wide enough to read as a
   * mistake rather than as breathing room.
   *
   * Now that the font has been measured the real height is known, so the band
   * is closed: the title box shrinks to what it uses and everything below it
   * moves up by the difference. Only on slides with an archetype — where the
   * geometry was code's to begin with — and only downward from the title, so
   * nothing a designer positioned by hand is second-guessed.
   */
  private compactTitleBand(
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
    font: Awaited<ReturnType<typeof loadFont>>,
  ): SlideSpec[] {
    if (!font) return slideSpecs;

    const theme = themeFromStyleSpec(styleSpec);
    let closed = 0;

    const compacted = slideSpecs.map((slide) => {
      if (!slide.archetype) return slide;

      const title = slide.elements.find(
        (element) => element.slot === 'title' && Boolean(element.text),
      );
      if (!title?.text) return slide;

      const size = title.fontSize ?? theme.sizes.title;
      // A safety margin on the width, not the real box width: fontkit's glyph
      // advances and the browser's own text layout agree closely but not to
      // the pixel, and a title that measures as JUST fitting one line here is
      // exactly the case that wraps to two in the live viewer. Measuring
      // against a slightly narrower line keeps that borderline case counted
      // as two lines, so the box is never shrunk out from under a line the
      // renderer is about to draw.
      const needed = measuredHeight(font, title.text, title.box.w * 0.95, size);
      const slack = title.box.h - needed;

      // Under a third of an inch is rhythm, not waste.
      if (slack < 0.3) return slide;

      closed += 1;
      const floor = title.box.y + title.box.h;
      const contentBottom = styleSpec.slideSize.height - styleSpec.spacing.outerMargin;

      // The lowest element in each slot — the only one that may GROW into the
      // freed space. Where a slot holds a stack (a sub-heading over its
      // bullets) every element in it moves up by the same slack, but growing
      // them all would run each one into the one below it, which is precisely
      // the overlap `applyLayouts` stacked them to avoid.
      const lowest = new Map<LayoutSlot, SlideElement>();
      for (const element of slide.elements) {
        if (!element.slot) continue;
        const current = lowest.get(element.slot);
        if (!current || element.box.y > current.box.y) lowest.set(element.slot, element);
      }

      return {
        ...slide,
        elements: slide.elements.map((element) => {
          if (element === title) {
            return { ...element, box: { ...element.box, h: needed } };
          }

          // Only what a slot placed below the title is touched — a
          // hand-positioned element keeps the position it was given.
          if (!element.slot || element.box.y < floor - 1e-6) return element;

          // Anything already sitting on the bottom margin is anchored there:
          // a footnote belongs at the foot of the slide, not tucked under the
          // content with an inch of nothing beneath it.
          const anchored = Math.abs(element.box.y + element.box.h - contentBottom) < 1e-6;
          if (anchored) return element;

          // Everything else takes the space rather than merely moving through
          // it: the top edge rises by the slack and the bottom edge stays put,
          // so the content band grows into the room the heading gave back.
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

    if (closed > 0) this.memory.step(`Closed the title gap on ${closed} slide(s)`);
    return compacted;
  }

  /**
   * Shrinks a row of `col-1`/`col-2`/`col-3` boxes to fit what is actually in
   * them.
   *
   * `slotsFor`'s three/two-column archetypes give every column the full
   * height of the content band, because the layout has to be sized before
   * anyone knows how much a designer will write in it — a short answer would
   * clip a long one. Most cards do not use all of that: two or three
   * 8-20-word bullets is a fraction of a full-height column, and the
   * difference reads as a slide of mostly-empty boxes rather than as a
   * designed one.
   *
   * Now that the real font is measured, the true content height is known, so
   * every column in the row is shrunk to the tallest one's actual need — kept
   * equal across the row, so the cards still read as one set, and centred in
   * the vertical space the archetype gave them rather than merely trimmed
   * from the bottom, so the row does not end up hugging the title with all
   * the freed space dumped below it.
   *
   * A column is a STACK, not a single box: `applyLayouts` may have divided
   * `col-1` between a sub-heading and the bullets under it. So a column's need
   * is the sum of its elements' plus the gaps between them, and the row is
   * re-stacked at the new height rather than every element being assigned the
   * same rectangle — which is how this pass used to undo the very separation
   * `applyLayouts` had just computed.
   */
  private compactColumnCards(
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
    font: Awaited<ReturnType<typeof loadFont>>,
  ): SlideSpec[] {
    if (!font) return slideSpecs;

    const theme = themeFromStyleSpec(styleSpec);
    const columnSlots: LayoutSlot[] = ['col-1', 'col-2', 'col-3'];
    const gap = styleSpec.spacing.elementGap;
    let compactedCount = 0;

    /** Real height this element's own text needs, at the size it will be drawn. */
    const needs = (element: SlideElement): number => {
      const isCard = element.type === 'card' || element.type === 'shape';
      const inset = isCard ? 0.17 * 2 : 0;
      const width = Math.max(0.1, element.box.w - inset);
      const size = element.fontSize ?? themeSizeFor(element.role, theme);
      return contentHeight(font, element, width, size, theme.spacing.paragraphGap) + inset;
    };

    const compacted = slideSpecs.map((slide) => {
      if (!slide.archetype) return slide;

      const stacks = columnSlots
        .map((slot) => slide.elements.filter((element) => element.slot === slot))
        .filter((stack) => stack.length > 0);
      if (stacks.length === 0) return slide;

      // The band the archetype gave the whole row, read back off the boxes
      // rather than recomputed — `compactTitleBand` may already have moved it.
      const bandTop = Math.min(...stacks.flat().map((element) => element.box.y));
      const bandBottom = Math.max(...stacks.flat().map((element) => element.box.y + element.box.h));
      const bandH = bandBottom - bandTop;

      const needed = stacks.map((stack) =>
        stack.reduce((total, element) => total + needs(element), 0) + gap * (stack.length - 1),
      );
      const maxNeeded = Math.max(...needed);
      const slack = bandH - maxNeeded;

      // Under a third of an inch is rhythm, not waste.
      if (slack < 0.3) return slide;

      compactedCount += 1;
      const top = bandTop + slack / 2;

      const boxes = new Map<SlideElement, Box>();
      for (const stack of stacks) {
        const band: Box = { x: stack[0].box.x, y: top, w: stack[0].box.w, h: maxNeeded };
        const split = stackInSlot(band, stack.map(needs), gap);
        stack.forEach((element, index) => boxes.set(element, split[index]));
      }

      return {
        ...slide,
        elements: slide.elements.map((element) => {
          const box = boxes.get(element);
          return box ? { ...element, box } : element;
        }),
      };
    });

    if (compactedCount > 0) {
      this.memory.step(`Fitted column cards to their content on ${compactedCount} slide(s)`);
    }
    return compacted;
  }

  /**
   * Grows a text box that is too short for its own text.
   *
   * The same trade as `fitToCanvas`, for the same reason. A designer working in
   * inches routinely gives a two-line heading a one-line box, and the layout
   * check duly reports it as critical — which buys a full revision round, at
   * roughly the price of the entire rest of the build, to correct a number the
   * pipeline can compute itself.
   *
   * Only downward, only into space that is genuinely free, and never past the
   * bottom margin. A box with nowhere to grow is left exactly as it is, so QA
   * still catches the cases that are a real design problem rather than
   * arithmetic.
   */
  private growTextBoxes(slideSpecs: SlideSpec[], styleSpec: StyleSpec): SlideSpec[] {
    const theme = themeFromStyleSpec(styleSpec);
    const floor = styleSpec.slideSize.height - styleSpec.spacing.outerMargin;
    let grown = 0;

    const fitted = slideSpecs.map((slide) => {
      const elements = slide.elements.map((element) => {
        const text = element.text ?? element.items?.join(' ') ?? '';
        if (!text || element.type === 'image') return element;

        const size =
          element.role === 'title'
            ? theme.sizes.title
            : element.role === 'subtitle'
              ? theme.sizes.subtitle
              : theme.sizes.body;

        const needed = estimateTextHeight(text, element.box.w, size);
        if (needed <= element.box.h) return element;

        // How far this box can grow before it reaches something beneath it, or
        // the bottom of the slide.
        const below = slide.elements
          .filter(
            (other) =>
              other !== element &&
              other.box.y >= element.box.y + element.box.h - 1e-6 &&
              other.box.x < element.box.x + element.box.w &&
              element.box.x < other.box.x + other.box.w,
          )
          .map((other) => other.box.y - styleSpec.spacing.elementGap);

        const ceiling = Math.min(floor, ...below);
        const height = Math.min(needed, ceiling - element.box.y);

        if (height <= element.box.h) return element;

        grown += 1;
        return { ...element, box: { ...element.box, h: height } };
      });

      return { ...slide, elements };
    });

    if (grown > 0) this.memory.step(`Grew ${grown} text box(es) to fit their own text`);
    return fitted;
  }

  /**
   * Nudges every element back onto the slide.
   *
   * The builder refuses to draw a box that leaves the canvas, and rightly so —
   * but a designer working in inches routinely overshoots by a tenth of one,
   * and killing a finished deck over that is a terrible trade. Sliding a box
   * back is arithmetic, so it happens here instead of costing a revision round.
   * Only genuinely misplaced boxes are worth a QA note.
   */
  private fitToCanvas(slideSpecs: SlideSpec[], styleSpec: StyleSpec): SlideSpec[] {
    let moved = 0;

    const fitted = slideSpecs.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => {
        if (isWithinSlide(styleSpec, element.box)) return element;

        moved += 1;
        return { ...element, box: fitToSlide(styleSpec, element.box) };
      }),
    }));

    if (moved > 0) this.memory.step(`Nudged ${moved} element(s) back onto the slide`);
    return fitted;
  }

  // ── 6. Fonts, then build ───────────────────────────────────────────────────

  /**
   * Resolves the analyzer's *estimated* typefaces to Google Fonts families that
   * exist, and writes them back onto the StyleSpec with a fallback chain.
   *
   * The proposal is a judgement, so a model makes it; availability is a fact,
   * so code checks it against `fonts.googleapis.com`. A family that fails
   * verification is sent back once with the failure attached; if the second
   * attempt also misses, the last link in the chain wins — the skill requires
   * that to be a font every machine has, so a deliberate Arial beats a
   * surprise Calibri.
   *
   * Runs once per build, immediately before the .pptx is assembled. Fonts do
   * not depend on the slides, so a revision round does not re-choose them.
   */
  private async curateFonts(spec: StyleSpec): Promise<void> {
    if (this.fontsCurated) return;

    this.memory.step('Choosing fonts...');

    const fontCurator = await this.specialist('font-curator');
    const weights = [
      spec.typography.body.weight,
      spec.typography.title.weight,
    ].filter((w, i, all) => all.indexOf(w) === i);

    const basePrompt = [
      this.context(MEMORY_KEYS.style),
      `Estimated heading font: ${spec.typography.headingFont}`,
      `Estimated body font: ${spec.typography.bodyFont}`,
      `Typography observed: ${JSON.stringify(spec.typography)}`,
      `Visual language: ${spec.visualLanguage}`,
      `Weights the deck uses: ${weights.join(', ')}`,
      'Return a FontPlan as JSON: heading and body, each with family, weights,',
      'fallbacks (most-similar first, ending in a system font) and rationale.',
    ]
      .filter(Boolean)
      .join('\n');

    let plan = await generateStructured({
      ...fontCurator,
      userPrompt: basePrompt,
      schema: fontPlanSchema,
      stage: 'font-curator',
    });

    let checks = await this.verifyFontPlan(plan);

    if (checks.some((c) => !c.result.available)) {
      const rejected = checks
        .filter((c) => !c.result.available)
        .map((c) => c.choice.family);

      this.memory.step(`Font not on Google Fonts, re-choosing: ${rejected.join(', ')}`);

      plan = await generateStructured({
        ...fontCurator,
        userPrompt: [
          basePrompt,
          `These families are NOT hosted by Google Fonts: ${rejected.join(', ')}.`,
          'Choose different families of the same classification and return a corrected FontPlan.',
        ].join('\n'),
        schema: fontPlanSchema,
        stage: 'font-curator',
      });

      checks = await this.verifyFontPlan(plan);
    }

    const resolve = (choice: FontChoice, available: boolean) =>
      available ? choice.family : (choice.fallbacks.at(-1) ?? choice.family);

    const headingAvailable = checks[0].result.available;
    const bodyAvailable = checks[1].result.available;

    spec.typography.headingFont = resolve(plan.heading, headingAvailable);
    spec.typography.bodyFont = resolve(plan.body, bodyAvailable);
    spec.typography.headingFontFallbacks = plan.heading.fallbacks;
    spec.typography.bodyFontFallbacks = plan.body.fallbacks;

    this.fontsCurated = true;

    this.memory.note(MEMORY_KEYS.fonts, {
      heading: spec.typography.headingFont,
      body: spec.typography.bodyFont,
      rationale: plan.heading.rationale,
    });

    this.memory.result('Fonts curated', {
      heading: spec.typography.headingFont,
      body: spec.typography.bodyFont,
      unverified: checks.filter((c) => !c.result.available).map((c) => c.choice.family),
    });
    this.memory.handoff(
      'font-curator',
      'pptx-generator',
      `${spec.typography.headingFont} / ${spec.typography.bodyFont}, verified on Google Fonts`,
    );
  }

  /** Checks both families in a plan against Google's catalogue. */
  private async verifyFontPlan(plan: FontPlan) {
    return Promise.all(
      [plan.heading, plan.body].map(async (choice) => ({
        choice,
        result: await checkGoogleFont.execute({
          family: choice.family,
          weights: choice.weights,
        }),
      })),
    );
  }

  // ── 7. Review ──────────────────────────────────────────────────────────────

  private async review(
    pptxPath: string,
    slideSpecs: SlideSpec[],
    styleSpec: StyleSpec,
    expectedSlideCount: number,
    budgetIssues: QAReport['issues'],
  ): Promise<QAReport> {
    this.setStatus('reviewing', 'Reviewing slides...');

    // Technical validation is non-negotiable and runs in code, not the model.
    const technical = await validatePptx.execute({ pptxPath, expectedSlideCount });

    const layout = await Promise.all(
      slideSpecs.map((slideSpec) => checkOverflow.execute({ slideSpec, styleSpec })),
    );

    // The only stage that actually looks at the deck. Renders every slide to a
    // contact sheet and asks a vision model what is wrong with it — the check
    // that catches what no rule was written for. Never fatal: a review that
    // cannot run returns nothing, which reads the same as a clean deck.
    const visual = await reviewLayoutVisually({ slideSpecs, styleSpec });
    const visualIssues = visual.review ? toQaIssues(visual.review) : [];

    if (visual.review) {
      this.memory.result('Deck reviewed visually', {
        slidesSeen: visual.slidesSeen,
        looksRight: visual.review.looksRight,
        findings: visualIssues.length,
      });
    } else if (serverEnv.visualReviewEnabled) {
      this.memory.error('Visual review could not run — the deck was not looked at');
    }

    const pptxReviewer = await this.specialist('pptx-reviewer');
    const report = await generateStructured({
      ...pptxReviewer,
      userPrompt: [
        this.context(MEMORY_KEYS.outline, MEMORY_KEYS.style, MEMORY_KEYS.fonts),
        `Technical validation: ${JSON.stringify(technical)}`,
        `Layout checks: ${JSON.stringify(layout.filter((l) => !l.fits))}`,
        `Word-budget overages (counted in code, not estimated): ${JSON.stringify(budgetIssues)}`,
        visualIssues.length > 0
          ? `What a vision model saw when it looked at the rendered deck: ${JSON.stringify(visualIssues)}`
          : '',
        `StyleSpec: ${JSON.stringify(styleSpec)}`,
        'Return a QAReport as JSON. Any technical failure or out-of-bounds element is critical.',
      ].join('\n\n'),
      schema: qaReportSchema,
      stage: 'pptx-reviewer',
    });

    // `out-of-bounds` and `overlap` are exact box arithmetic — the same kind
    // of fact `technical.problems` is, not an opinion — so they are counted
    // at `critical` here rather than merely described to the reviewer.
    // `text-overflow` stays at `major`: it is an *estimate* (no font-metrics
    // engine in this check), and `fitTypeToBoxes` runs after this point in
    // the pipeline and may still shrink the text to fit before the deck ships.
    const layoutIssues: QAReport['issues'] = layout.flatMap((slideCheck) =>
      slideCheck.issues
        .filter((issue) => issue.kind === 'out-of-bounds' || issue.kind === 'overlap')
        .map((issue) => ({
          severity: 'critical' as const,
          slideNumber: slideCheck.slideNumber,
          category: (issue.kind === 'overlap' ? 'overlap' : 'overflow') as 'overlap' | 'overflow',
          description: `Slide ${slideCheck.slideNumber} (${issue.role}): ${issue.detail}`,
        })),
    );

    // Counted facts are not the reviewer's to overrule, any more than a failed
    // technical check is — so both are merged in rather than left to its
    // judgement about whether ninety words on a slide is really a problem.
    //
    // The reviewer's OWN issues are capped at `major`, which is the whole
    // point of this arrangement. It never sees a rendered slide: its inputs
    // are the technical validation and the layout checks, both of which are
    // merged in above with their real severity. Anything it adds on top is
    // inference, and a revision round costs about as much as the rest of the
    // build — twice, in the runs where it declared six criticals over a deck
    // that code had just found nothing wrong with. Downgrading keeps its
    // observations (they steer the next revision when one does happen) while
    // making the decision to spend that money a deterministic one.
    const merged: QAReport['issues'] = [
      ...technical.problems.map((description) => ({
        severity: 'critical' as const,
        category: 'technical' as const,
        description,
      })),
      ...layoutIssues,
      ...budgetIssues,
      // Capped at `major` by construction — see ./tools/review-layout for why
      // an opinion about a picture may not force a revision round.
      ...visualIssues,
      ...report.issues.map((issue) => ({
        ...issue,
        severity: issue.severity === 'critical' ? ('major' as const) : issue.severity,
      })),
    ];

    const blocking = merged.some((issue) => issue.severity === 'critical');

    return {
      // `report.passed` is deliberately not consulted: the same reasoning
      // applies to the reviewer's overall verdict as to its severities.
      passed: technical.valid && !blocking,
      issues: merged,
    };
  }

  // ── Phase 1: draft, for review ──────────────────────────────────────────────

  /**
   * Researches the topic and plans the deck, then stops.
   *
   * Everything a person needs to judge whether this is the deck they wanted,
   * and nothing that costs real money. The caller stores the result and shows
   * it; `buildApproved` picks up from there.
   */
  async draft(): Promise<DraftResult> {
    return withReasoning(
      (stage, delta) => this.memory.reasoning(stage, delta),
      async () => {
        try {
          const research = await this.research();
          this.state.researchBrief = research;

          const plan = await this.planContent(research);
          this.state.contentPlan = plan;

          this.setStatus('awaiting-review', 'Outline ready for review');
          return { success: true, research, plan };
        } catch (error) {
          return { success: false, error: this.describe(error) };
        }
      },
    );
  }

  /**
   * Rewrites the plan to follow an instruction from the user.
   *
   * One call, to the same specialist that wrote it, with the plan it produced
   * and what the person wants changed. The ResearchBrief goes along so a
   * revision cannot invent facts to satisfy a request — "add a slide on cost"
   * has to be answered from what was actually found, or answered honestly by
   * saying nothing was.
   *
   * `normalisePlan` runs again afterwards, because a revision can just as
   * easily drop the conclusion as the original could.
   */
  async revisePlan(
    plan: ContentPlan,
    research: ResearchBrief,
    instruction: string,
  ): Promise<DraftResult> {
    return withReasoning(
      (stage, delta) => this.memory.reasoning(stage, delta),
      async () => {
        try {
          this.setStatus('planning', 'Revising the outline...');

          const contentPlanner = await this.specialist('content-planner');

          const revised = await generateStructured({
            ...contentPlanner,
            userPrompt: [
              `Request: ${this.state.userRequest}`,
              `ResearchBrief (the only facts this deck may state): ${JSON.stringify(research)}`,
              `The current plan: ${JSON.stringify(plan)}`,
              '',
              'The user has reviewed that plan and asked for this change:',
              instruction,
              '',
              'Return the COMPLETE revised ContentPlan as JSON — every slide, not',
              'just the ones you changed. Keep everything the user did not ask you',
              'to alter. If the request cannot be met from the ResearchBrief, keep',
              'the plan as it is rather than inventing facts to satisfy it.',
            ].join('\n'),
            schema: contentPlanSchema,
            stage: 'content-planner',
          });

          const normalised = this.normalisePlan(revised);
          this.state.contentPlan = normalised;

          this.memory.result('Outline revised', {
            slides: normalised.slides.length,
            instruction: instruction.slice(0, 120),
          });

          return { success: true, research, plan: normalised };
        } catch (error) {
          return { success: false, error: this.describe(error) };
        }
      },
    );
  }

  // ── Phase 2: build, once approved ───────────────────────────────────────────

  /**
   * Builds the deck from a plan a person has already approved.
   *
   * Skips research and planning entirely — they happened before the review and
   * their results are handed in. Everything from the style analysis onward is
   * identical to an unattended run.
   */
  async buildApproved(plan: ContentPlan, research?: ResearchBrief): Promise<GenerationResult> {
    if (research) {
      this.state.researchBrief = research;
      this.memory.note(MEMORY_KEYS.research, {
        summary: research.summary,
        findings: research.findings.length,
        keyTerms: research.keyTerms,
        openQuestions: research.openQuestions,
      });
    }

    this.state.contentPlan = plan;
    this.memory.note(MEMORY_KEYS.outline, {
      title: plan.title,
      objective: plan.objective,
      audience: plan.audience,
      maxWordsPerSlide: plan.maxWordsPerSlide,
      slides: plan.slides.map((slide) => ({
        number: slide.number,
        section: slide.section,
        keyMessage: slide.keyMessage,
        wordBudget: slide.wordBudget,
      })),
    });

    return withReasoning(
      (stage, delta) => this.memory.reasoning(stage, delta),
      () => this.assemble(plan),
    );
  }

  /** An unknown throw, as the error shape every entry point returns. */
  private describe(error: unknown): { code: string; message: string } {
    this.state.status = 'error';

    const agentError =
      error instanceof AgentError
        ? error
        : new AgentError(
            error instanceof Error ? error.message : String(error),
            'UNKNOWN',
            'manager',
          );

    this.memory.error(agentError.message, {
      code: agentError.code,
      stage: agentError.stage,
    });

    // Code and message only — never a stack trace or env detail.
    return { code: agentError.code, message: agentError.message };
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  /**
   * Runs the pipeline.
   *
   * Wrapped in `withReasoning` so every model call inside it streams its
   * thinking into this run's memory — and from there into whatever the caller
   * attached as a log listener. That is the whole debugging story for a
   * pipeline whose failures are judgements rather than exceptions.
   */
  async run(): Promise<GenerationResult> {
    return withReasoning(
      (stage, delta) => this.memory.reasoning(stage, delta),
      () => this.build(),
    );
  }

  private async build(): Promise<GenerationResult> {
    try {
      // 1 — facts. Nothing downstream may state anything this did not find.
      const researchBrief = await this.research();
      this.state.researchBrief = researchBrief;

      // 2 — narrative. Selects and sequences those facts, and sets the budgets.
      const contentPlan = await this.planContent(researchBrief);
      this.state.contentPlan = contentPlan;

      return await this.assemble(contentPlan);
    } catch (error) {
      return { success: false, error: this.describe(error) };
    }
  }

  /**
   * Everything from the style analysis to the finished file.
   *
   * Split out from `build` so the reviewed path can re-enter here with a plan
   * a person has approved, rather than paying for research and planning twice.
   */
  private async assemble(contentPlan: ContentPlan): Promise<GenerationResult> {
    try {
      // 3 — the design system, which every image and every text size comes from.
      const styleSpec = await this.analyzeStyle();
      this.state.styleSpec = styleSpec;

      let feedback: QAReport | undefined;
      // Set once the first attempt finishes, so a revision round has a
      // finished deck's images to reuse instead of generating its own.
      let previousSlideSpecs: SlideSpec[] | undefined;

      while (this.state.revisionCount <= MAX_REVISIONS) {
        // Each attempt tracks only what IT generates — carried-forward images
        // from a previous round are not new spend, so they are not counted
        // here (see `collectImagePaths`, which is what actually gets uploaded).
        this.imagePaths = [];

        // 4 — the words on the slides, inside the budget.
        const designed = await this.designSlides(contentPlan, styleSpec, feedback);
        // Geometry first: everything after this works on rectangles code chose.
        const laid = this.applyLayouts(designed, styleSpec);
        const titled = this.ensureTitleElements(laid, styleSpec);
        // Counted after the titles are drawn, because the budget always
        // covered the title — counting first would let a slide pass and then
        // grow by three words. Pictures carry no words, so they come after.
        const budgetIssues = await this.enforceWordBudgets(titled, contentPlan);

        // 5 — the pictures, all from one locked style block. Every slide gets
        // one: an illustration where there is room, a backdrop where there is
        // not.
        const visual = this.ensureSlideVisuals(titled, styleSpec, contentPlan);

        // A revision exists to fix what QA flagged — wording, budget,
        // geometry — never a picture QA had no complaint about. So a revision
        // round reuses the previous round's pictures instead of asking
        // background-designer and generate_image to make new ones; only a
        // slide left without one (new, or one QA specifically called wrong)
        // gets a fresh image, in `illustrate` below.
        const withVisuals = previousSlideSpecs
          ? this.carryForwardImages(visual.slideSpecs, previousSlideSpecs)
          : await this.designBackgrounds(visual.slideSpecs, styleSpec, visual.needBackdrop);

        const illustrated = await this.illustrate(withVisuals, styleSpec);
        const placed = this.fitToCanvas(
          this.growTextBoxes(illustrated, styleSpec),
          styleSpec,
        );
        // Last, because it measures against the boxes everything above settled
        // on. Fonts are curated below, but the family is already known — the
        // curator only confirms it against Google's catalogue.
        // Motion last, and after every geometry pass on purpose: it reads the
        // final element list to compute its cascade, and it must never be able
        // to influence a rectangle. Nothing below this line looks at it — the
        // builder, the rasteriser and QA all work on the same specs they
        // always did.
        const slideSpecs = this.ensureSlideMotion(await this.fitTypeToBoxes(placed, styleSpec));
        this.state.slideSpecs = slideSpecs;
        previousSlideSpecs = slideSpecs;

        const withoutVisual = slideSpecs.filter(
          (slide) =>
            !slide.background?.imagePath &&
            !slide.elements.some((element) => element.type === 'image'),
        );

        this.memory.note(MEMORY_KEYS.imagery, {
          images: this.imagePaths.length,
          backgrounds: slideSpecs.filter((slide) => slide.background?.imagePath).length,
        });

        // Every slide is meant to have one by construction, so a slide without
        // one means a picture failed to generate — worth saying, since the
        // deck still ships and the gap is otherwise silent.
        if (withoutVisual.length > 0) {
          this.memory.error(`${withoutVisual.length} slide(s) ended up with no visual`, {
            slides: withoutVisual.map((slide) => slide.slideNumber),
          });
        }
        this.memory.handoff(
          'background-designer',
          'font-curator',
          `${this.imagePaths.length} image(s) rendered from one locked style block`,
        );

        // 6 — the typeface, verified against Google Fonts, then the file.
        this.setStatus('generating', 'Choosing fonts and building the PowerPoint...');
        await this.curateFonts(styleSpec);
        const built = await createPptx.execute({ styleSpec, slideSpecs });
        this.state.pptxPath = built.pptxPath;

        // 7 — QA.
        const qa = await this.review(
          built.pptxPath,
          slideSpecs,
          styleSpec,
          built.slideCount,
          budgetIssues,
        );
        this.state.qaReport = qa;

        const critical = qa.issues.filter((i) => i.severity === 'critical');
        const presentation = {
          id: built.id,
          filename: built.filename,
          // An opaque route, never the server path.
          downloadUrl: `/api/presentations/${built.id}`,
          slideCount: built.slideCount,
        };
        const artifacts = {
          pptxPath: built.pptxPath,
          styleSpec,
          slideSpecs,
          // Every file this deck's finished slides actually reference — not
          // `this.imagePaths`, which is only this round's newly-generated
          // count. A revision round that reused every picture from the round
          // before it must still upload those files; they were never
          // uploaded, because the round that generated them never finished.
          imagePaths: this.collectImagePaths(slideSpecs),
        };

        if (qa.passed && critical.length === 0) {
          this.setStatus('complete', 'Finalizing...');
          return { success: true, presentation, qa, artifacts };
        }

        this.state.revisionCount += 1;

        if (this.state.revisionCount > MAX_REVISIONS) {
          this.memory.error('Revision budget exhausted', { issues: critical.length });
          // Return the deck we have alongside the report — a flawed deck the
          // user can inspect beats an opaque failure.
          return { success: true, presentation, qa, artifacts };
        }

        feedback = qa;
        this.memory.step(`Revision ${this.state.revisionCount} of ${MAX_REVISIONS}`, {
          critical: critical.length,
          major: qa.issues.filter((i) => i.severity === 'major').length,
        });
      }

      throw new AgentError('Generation loop exited unexpectedly', 'LOOP_EXIT', 'manager');
    } catch (error) {
      return { success: false, error: this.describe(error) };
    }
  }

  trace(): string {
    return this.memory.summary();
  }

  /**
   * Drops this run's working memory.
   *
   * Call it once the .pptx has been stored. The memory holds research notes,
   * prompts and reasoning traces for a deck that is now finished, and this
   * process may live for days.
   */
  dispose(): void {
    disposeMemory(this.runId);
  }
}
