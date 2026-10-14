/**
 * Which generator serves a request, and what each one costs.
 *
 * The default is the cloud engine, and the reason is arithmetic rather than
 * taste. A 60-second lesson costs about USD 1.06 illustrated through Gemini and
 * Higgsfield, against about USD 0.043 on a self-hosted RTX 6000 Ada — but the
 * self-hosted figure only holds while the card is busy. One always-on pod is
 * roughly USD 562 a month, so the paths cross at **15 to 18 lessons a day**.
 * Below that the cloud engine is cheaper and needs no GPU operations at all;
 * above it the GPU path wins and keeps widening.
 *
 * So: start on cloud, measure, and switch by setting `LESSON_GENERATOR=gpu`
 * when the daily count passes the crossover. The switch is an environment
 * variable because that is the honest shape of the decision — it depends on
 * volume, which changes, not on code.
 *
 * `fixture` exists for load tests. It opens no job and spends nothing, which is
 * what makes a 300-user rehearsal affordable (the same idea as the retired
 * prototype's `DRY_RUN=1`, in the place it belongs).
 */

import {
  type GeneratorCapabilities,
  type LessonRequest,
  type LessonVisualStyle,
} from './types';

export type GeneratorId = 'cloud' | 'gpu' | 'fixture';

export const GENERATOR_IDS: readonly GeneratorId[] = ['cloud', 'gpu', 'fixture'];

/**
 * Measured cloud rates, from `CLOUD_LESSON_STORYBOOK_COSTS` and the Higgsfield
 * per-second rate in `src/lib/env.ts`. Re-measure with `npm run
 * smoke:cloud-storybook` when a model changes; these are what the estimate
 * shows a teacher before they spend.
 */
const CLOUD_RATES = {
  planUsd: 0.035,
  voiceUsdPer30s: 0.006,
  pictureUsd: 0.061,
  animationUsdPerSecond: 0.035,
  animationSeconds: 5,
} as const;

/** Mirrors `cloudLessonAnimationCap` in the cloud contracts. */
function animatedScenes(style: LessonVisualStyle, durationSeconds: 30 | 60): number {
  if (style === 'storybook') return durationSeconds / 7.5 <= 4 ? 1 : 2;
  if (style === 'illustrated') return durationSeconds === 30 ? 2 : 3;
  return durationSeconds === 30 ? 4 : 6;
}

/** Storybook draws two pictures a scene; the others draw one. */
function pictures(style: LessonVisualStyle, durationSeconds: 30 | 60): number {
  return (durationSeconds / 7.5) * (style === 'storybook' ? 2 : 1);
}

export function cloudEstimateUsd(request: LessonRequest): number {
  const { planUsd, voiceUsdPer30s, pictureUsd, animationUsdPerSecond, animationSeconds } = CLOUD_RATES;
  const usd = planUsd
    + voiceUsdPer30s * (request.durationSeconds / 30)
    + pictureUsd * pictures(request.visualStyle, request.durationSeconds)
    + animatedScenes(request.visualStyle, request.durationSeconds) * animationSeconds * animationUsdPerSecond;
  return Math.round(usd * 1e4) / 1e4;
}

/**
 * GPU-seconds per lesson, from the benchmarks committed in
 * `ops/runpod/results-2026-09-21.csv`: 4.03 s an image and 48.15 s a clip on an
 * RTX 6000 Ada, plus planning, translation, vision checks and speech.
 *
 * The last four are estimates — the committed CSV measures images and clips
 * only — so this is marked as such rather than quoted as measured.
 */
const GPU_SECONDS = { image: 4.03, clip: 48.15, overheadPerLesson: 91 } as const;

/** One RTX 6000 Ada at an indicative USD 0.77 an hour. */
const GPU_USD_PER_SECOND = 0.77 / 3600;

export function gpuEstimateUsd(request: LessonRequest): number {
  const scenes = request.durationSeconds / 7.5;
  const seconds = GPU_SECONDS.overheadPerLesson
    + scenes * GPU_SECONDS.image
    + animatedScenes(request.visualStyle, request.durationSeconds) * GPU_SECONDS.clip;
  return Math.round(seconds * GPU_USD_PER_SECOND * 1e4) / 1e4;
}

export const CLOUD_CAPABILITIES: GeneratorCapabilities = {
  languages: ['en-IN', 'hi-IN', 'kn-IN'],
  visualStyles: ['illustrated', 'editorial', 'storybook'],
  durationsSeconds: [30, 60],
  producesPptx: false,
  requiresGpu: false,
  estimateUsd: cloudEstimateUsd,
};

/**
 * The self-hosted path ships one style and one length today, and nine
 * languages — `src/lib/videos/languages.ts` lists them, where the cloud engine
 * is capped at three by a column check. Narrower where it is narrower, wider
 * where it is wider; neither is pretending.
 */
export const GPU_CAPABILITIES: GeneratorCapabilities = {
  languages: ['en-IN', 'hi-IN', 'kn-IN'],
  visualStyles: ['editorial'],
  durationsSeconds: [60],
  producesPptx: false,
  requiresGpu: true,
  estimateUsd: gpuEstimateUsd,
};

export const FIXTURE_CAPABILITIES: GeneratorCapabilities = {
  languages: ['en-IN', 'hi-IN', 'kn-IN'],
  visualStyles: ['illustrated', 'editorial', 'storybook'],
  durationsSeconds: [30, 60],
  producesPptx: false,
  requiresGpu: false,
  estimateUsd: () => 0,
};

export const CAPABILITIES: Record<GeneratorId, GeneratorCapabilities> = {
  cloud: CLOUD_CAPABILITIES,
  gpu: GPU_CAPABILITIES,
  fixture: FIXTURE_CAPABILITIES,
};

export function isGeneratorId(value: string): value is GeneratorId {
  return (GENERATOR_IDS as readonly string[]).includes(value);
}

/**
 * The configured generator.
 *
 * Unset means `cloud`: a fresh deployment should work with no GPU anywhere,
 * and an unreadable value is refused rather than silently defaulted — a typo
 * that quietly moves every lesson onto a different cost base is worse than a
 * failed boot.
 */
export function generatorIdFromEnv(raw: string | undefined): GeneratorId {
  const value = (raw ?? 'cloud').trim().toLowerCase();
  if (!isGeneratorId(value)) {
    throw new Error(
      `LESSON_GENERATOR must be one of ${GENERATOR_IDS.join(', ')}; got "${raw}".`,
    );
  }
  return value;
}

/**
 * Where the crossover sits, in lessons a day, for this request shape.
 *
 * Returns null when the GPU path cannot serve the request at all, because a
 * comparison against a provider that would refuse the job is not a comparison.
 * `monthlyGpuUsd` defaults to one always-on RTX 6000 Ada at an indicative rate.
 */
export function crossoverLessonsPerDay(
  request: LessonRequest,
  monthlyGpuUsd = 0.77 * 730,
): number | null {
  const saving = cloudEstimateUsd(request) - gpuEstimateUsd(request);
  if (saving <= 0) return null;
  return Math.ceil(monthlyGpuUsd / saving / 30);
}
