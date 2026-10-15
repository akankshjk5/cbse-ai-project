/**
 * Which model serves each stage, and the rule that a paid provider is never
 * reached by accident.
 *
 * The platform's primary strategy is self-hosted: open models on GPU
 * infrastructure we control. Paid third-party generation APIs are optional,
 * disabled unless named, and **never** selected as a fallback when a local
 * service is down. A failure that silently becomes a Gemini bill is worse than
 * a failure that stops — the bill is discovered at the end of the month, the
 * stoppage is discovered immediately.
 *
 * So there are two separate questions, and this module keeps them separate:
 *
 *   1. Which provider is CONFIGURED for a stage (`resolveStage`)
 *   2. What happens when it fails (`recoveryFor`) — retry or stop, never
 *      "quietly try the paid one"
 *
 * `src/lib/generation/providers/registry.ts` picks the engine; this picks the
 * model behind each stage of it.
 */

/** The four stages a lesson passes through that can call a model. */
export const GENERATION_STAGES = ['plan', 'image', 'speech', 'motion'] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

/**
 * `local` runs on our own GPU. `external` is a paid third-party API.
 * `deterministic` calls no model at all — FFmpeg and the compositor.
 */
export type ProviderKind = 'local' | 'external' | 'deterministic';

export interface StageProvider {
  id: string;
  kind: ProviderKind;
  /** The model or service that actually does the work. */
  model: string;
  /** Null when nothing is billed per use — our own hardware, or no model. */
  usdPerUnit: number | null;
  licence: string;
}

/**
 * The self-hosted default for every stage.
 *
 * `motion` is deliberately deterministic: FFmpeg camera motion over an approved
 * still is both cheaper and more faithful than regenerating the picture, and a
 * diffusion model that changes a count or a symbol after the visual was audited
 * has produced a worse teaching artefact however smooth it looks. Wan is opted
 * into per scene, not applied to all of them — see `animatedSceneCap`.
 */
export const LOCAL_PROVIDERS: Record<GenerationStage, StageProvider> = {
  plan: { id: 'local-planner', kind: 'local', model: 'Qwen3-4B', usdPerUnit: null, licence: 'Apache-2.0' },
  image: { id: 'local-image', kind: 'local', model: 'Z-Image Turbo BF16', usdPerUnit: null, licence: 'Apache-2.0' },
  speech: { id: 'local-tts', kind: 'local', model: 'Indic Parler-TTS', usdPerUnit: null, licence: 'Apache-2.0' },
  motion: { id: 'ffmpeg-motion', kind: 'deterministic', model: 'FFmpeg zoompan', usdPerUnit: null, licence: 'n/a' },
};

/**
 * The paid alternatives. Reachable only by naming one in `EXTERNAL_PROVIDERS`,
 * and refused outright unless `ALLOW_EXTERNAL_PROVIDERS` is also set — two
 * switches, because one switch gets flipped during an incident and never
 * flipped back.
 */
export const EXTERNAL_PROVIDERS: Record<GenerationStage, StageProvider | null> = {
  plan: { id: 'gemini-planner', kind: 'external', model: 'gemini-3.8-flash', usdPerUnit: 0.035, licence: 'commercial API' },
  image: { id: 'gemini-image', kind: 'external', model: 'gemini-nano-banana-2.1', usdPerUnit: 0.061, licence: 'commercial API' },
  speech: { id: 'gemini-tts', kind: 'external', model: 'gemini-3.8-flash-tts', usdPerUnit: 0.006, licence: 'commercial API' },
  motion: { id: 'higgsfield', kind: 'external', model: 'kling-video/v2.5-turbo/pro/image-to-video', usdPerUnit: 0.175, licence: 'commercial API' },
};

/** The local video model, opted into per scene rather than per lesson. */
export const LOCAL_MOTION_MODEL: StageProvider = {
  id: 'local-video', kind: 'local', model: 'Wan 2.2 TI2V-5B FP16', usdPerUnit: null, licence: 'Apache-2.0',
};

export class ExternalProviderRefused extends Error {
  constructor(stage: GenerationStage, reason: string) {
    super(`Refusing to use a paid provider for ${stage}: ${reason}`);
    this.name = 'ExternalProviderRefused';
  }
}

export interface PolicyEnv {
  /** Comma-separated stage names that may use a paid API. Empty by default. */
  externalStages?: string;
  /** Must be exactly "true" for any paid provider to be reachable at all. */
  allowExternal?: string;
}

function enabledStages(env: PolicyEnv): Set<GenerationStage> {
  if ((env.allowExternal ?? '').trim().toLowerCase() !== 'true') return new Set();
  const named = (env.externalStages ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const stages = new Set<GenerationStage>();
  for (const name of named) {
    if (!(GENERATION_STAGES as readonly string[]).includes(name)) {
      throw new Error(
        `EXTERNAL_PROVIDERS names an unknown stage "${name}"; expected ${GENERATION_STAGES.join(', ')}.`,
      );
    }
    stages.add(name as GenerationStage);
  }
  return stages;
}

/**
 * The provider configured for a stage.
 *
 * Local unless the stage was explicitly named AND the master switch is on. A
 * stage named without the master switch resolves local rather than throwing:
 * the configuration is wrong, but the safe reading of it is "do not spend".
 */
export function resolveStage(stage: GenerationStage, env: PolicyEnv = {}): StageProvider {
  const external = enabledStages(env).has(stage) ? EXTERNAL_PROVIDERS[stage] : null;
  return external ?? LOCAL_PROVIDERS[stage];
}

export function resolveAll(env: PolicyEnv = {}): Record<GenerationStage, StageProvider> {
  return {
    plan: resolveStage('plan', env),
    image: resolveStage('image', env),
    speech: resolveStage('speech', env),
    motion: resolveStage('motion', env),
  };
}

/** True when any stage is configured to spend money at a third party. */
export function usesPaidProvider(env: PolicyEnv = {}): boolean {
  return GENERATION_STAGES.some((stage) => resolveStage(stage, env).kind === 'external');
}

export type Recovery =
  | { action: 'retry'; provider: StageProvider }
  | { action: 'stop'; reason: string };

/**
 * What to do when a stage's provider fails.
 *
 * Always the same provider again, or stop. There is deliberately no branch
 * that returns a different `kind` than the one that failed — which is what
 * makes "never silently fall back to a paid provider" a property of the type
 * rather than a rule someone has to remember.
 */
export function recoveryFor(
  stage: GenerationStage,
  attempt: number,
  maxAttempts: number,
  env: PolicyEnv = {},
): Recovery {
  const provider = resolveStage(stage, env);
  if (attempt >= maxAttempts) {
    return { action: 'stop', reason: `${provider.id} failed ${attempt} times` };
  }
  return { action: 'retry', provider };
}

/**
 * Asserts a paid provider was actually asked for before one is used.
 *
 * Called at the point of spend, not at configuration time, so a code path that
 * reaches a billed API without passing through `resolveStage` still fails
 * closed.
 */
export function assertExternalAllowed(stage: GenerationStage, env: PolicyEnv = {}): void {
  if (resolveStage(stage, env).kind !== 'external') {
    throw new ExternalProviderRefused(
      stage,
      'set ALLOW_EXTERNAL_PROVIDERS=true and name the stage in EXTERNAL_PROVIDERS',
    );
  }
}

/**
 * How many of a lesson's scenes may use a generative video model.
 *
 * The rest get deterministic motion. These mirror the caps the database
 * enforces, so the two cannot disagree about what a lesson is allowed to spend.
 */
export function animatedSceneCap(style: string, durationSeconds: 30 | 60): number {
  const scenes = durationSeconds / 7.5;
  if (style === 'storybook') return scenes <= 4 ? 1 : 2;
  if (style === 'illustrated') return durationSeconds === 30 ? 2 : 3;
  return durationSeconds === 30 ? 4 : 6;
}

/**
 * The policy as the running process sees it.
 *
 * Every enforcement point reads the environment through this, so a test can
 * pass an explicit `PolicyEnv` and production cannot accidentally read a
 * different pair of variables.
 */
export function policyEnv(): PolicyEnv {
  return {
    externalStages: process.env.EXTERNAL_PROVIDERS,
    allowExternal: process.env.ALLOW_EXTERNAL_PROVIDERS,
  };
}

/**
 * Guard a paid provider at the point it is constructed.
 *
 * Called inside the factories rather than at each call site: a new caller
 * cannot bypass a check it never has to remember, and there is exactly one
 * place per provider where spending becomes possible.
 */
export function guardExternalFactory(stage: GenerationStage, env: PolicyEnv = policyEnv()): void {
  assertExternalAllowed(stage, env);
}
