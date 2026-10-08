/**
 * What a deck costs to build.
 *
 * Every figure here is **measured**, not quoted from a rate card. Reasoning
 * tokens bill as output, so a model's advertised price says very little about
 * what a call actually costs: `deepseek-v4-flash` has the lowest sticker price
 * of anything in the pipeline and measured 38x more per call than
 * `glm-5.3-flash` on the same prompt, because it spent eighty seconds thinking
 * about it. The only number worth optimising is cost per call, and the only
 * way to get it is to run the call.
 *
 * These come from `npm run smoke:deck`, which prints the cost of every stage.
 * Re-measure and update them when the model table in CLAUDE.md changes.
 *
 * The estimate exists so a user can see the price **before** approving a
 * build, which is the whole point of the review gate: research and planning
 * cost about a cent, and everything after them costs twenty to thirty times
 * that. Being able to say "this will be 29 cents" is what makes stopping to
 * ask worthwhile.
 */

/** Measured cost of one call to each specialist, in USD. */
export const STAGE_COST_USD = {
  researcher: 0.0104,
  // TODO: measure via `npm run smoke:research` and replace this placeholder.
  'research-critic': 0,
  'content-planner': 0.0007,
  // TODO: measure via `npm run smoke:research` and replace this placeholder.
  'plan-critic': 0,
  'style-analyzer': 0.0026,
  // TODO: measure via `npm run smoke:deck` and replace this placeholder.
  'style-critic': 0,
  'slide-designer': 0.0007,
  'background-designer': 0.0002,
  // TODO: measure via `npm run smoke:deck` and replace this placeholder.
  'background-critic': 0,
  'font-curator': 0.0002,
  'pptx-reviewer': 0.0001,
} as const;

/**
 * One generated image, measured on `gemini-3.1-flash-lite-image`.
 *
 * This is the number that matters. Illustration is ~90% of a deck's bill, and
 * the frontier image models are worse value than they look: measured on the
 * same prompt, `flash-image` cost 2x this and `pro-image` 4x, and the most
 * expensive produced the least legible picture of the three.
 */
export const IMAGE_COST_USD = 0.0342;

/** Roughly how many slides get a generated backdrop as well as an illustration. */
const BACKDROP_SHARE = 0.3;

export interface CostEstimate {
  /** Research and planning — everything before the review gate. */
  draftUsd: number;
  /** Everything after approval: style, writing, images, fonts, QA. */
  buildUsd: number;
  totalUsd: number;
  /** How many pictures the build is expected to generate. */
  images: number;
  /** The image half of `buildUsd`, which is nearly all of it. */
  imagesUsd: number;
  /** What a revision round would add, if QA forces one. */
  revisionUsd: number;
}

/**
 * What building `slideCount` slides will cost.
 *
 * Deliberately an over-estimate rather than an average: a user told 25 cents
 * and charged 30 has been misled, and one told 30 and charged 25 has not. So
 * every slide is assumed to want an illustration (which the pipeline now
 * guarantees) and a share of them a backdrop too.
 */
export function estimateDeckCost(
  slideCount: number,
  options: { imagesEnabled?: boolean } = {},
): CostEstimate {
  const imagesEnabled = options.imagesEnabled ?? true;

  // research-critic and plan-critic each add at most one critique call plus
  // one revision call to the draft — both run before the approval gate, so
  // they must be in the number a user sees before committing to spend.
  const draftUsd =
    STAGE_COST_USD.researcher +
    STAGE_COST_USD['research-critic'] +
    STAGE_COST_USD['content-planner'] +
    STAGE_COST_USD['plan-critic'];

  // One call each, except the font curator which may be asked twice when its
  // first choice is not on Google Fonts. style-critic and background-critic
  // run after approval, so their cost belongs here, not in draftUsd.
  const buildText =
    STAGE_COST_USD['style-analyzer'] +
    STAGE_COST_USD['style-critic'] +
    STAGE_COST_USD['slide-designer'] +
    STAGE_COST_USD['background-designer'] +
    STAGE_COST_USD['background-critic'] +
    STAGE_COST_USD['font-curator'] +
    STAGE_COST_USD['pptx-reviewer'];

  const images = imagesEnabled ? Math.ceil(slideCount * (1 + BACKDROP_SHARE)) : 0;
  const imagesUsd = images * IMAGE_COST_USD;

  // A revision re-runs the designer and the reviewer, but reuses every
  // picture QA did not flag — `Manager.carryForwardImages` — so it does NOT
  // pay for `imagesUsd` again. Only a slide left without a picture (new, or
  // one QA specifically called wrong) generates one; that is rare enough,
  // and cheap enough per image, not to be worth estimating until real
  // distributions are measured.
  //
  // TODO: does not model the compounding edge case where this QA revision
  // round also re-triggers a style-critic or background-critic revision —
  // same reasoning.
  const revisionUsd = STAGE_COST_USD['slide-designer'] + STAGE_COST_USD['pptx-reviewer'];

  const buildUsd = buildText + imagesUsd;

  return {
    draftUsd,
    buildUsd,
    totalUsd: draftUsd + buildUsd,
    images,
    imagesUsd,
    revisionUsd,
  };
}

/** A price a person can read. Sub-cent amounts round up rather than to zero. */
export function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}
