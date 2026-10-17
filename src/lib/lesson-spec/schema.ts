/**
 * One record per lesson, and the only thing the video and the deck are built
 * from.
 *
 * Before this existed, a scene's picture, its narration and its slide were
 * produced by three code paths that each re-derived what the scene was about.
 * They drifted: a caption fixed in the deck stayed wrong in the video, and
 * nothing could say which asset belonged to which sentence. A scene here owns
 * its facts, its prompts, its clip, its three narrations and its subtitle, and
 * everything downstream reads them from one place.
 *
 * Two rules give the record its shape:
 *
 *   1. A scene is identified by `id`, never by its position. Reordering scenes
 *      must not invalidate a keyframe that cost GPU minutes, and an edit to
 *      scene 3 must be attributable to scene 3 after the array moves.
 *   2. Every expensive artefact carries the hash of exactly the inputs that
 *      determine it. That is what lets a caption fix re-run FFmpeg alone
 *      instead of redrawing four pictures.
 */

import { z } from 'zod';

/**
 * Bumped whenever a scene's shape changes.
 *
 * This is the `contentVersion` dimension in `CompatibilityKey`: a lesson built
 * under an older shape is not reused under a newer one, because the fields the
 * compositor reads may no longer mean the same thing.
 */
export const SPEC_VERSION = '1.0.0';

/** The slot is fixed by the media-worker schema; scenes cannot vary from it. */
export const SLOT_SECONDS = 7.5;
/** A product rule. 8 scenes would be 60 s, so the 8-scene option cannot exist. */
export const MAX_LESSON_SECONDS = 40;

export const LANGUAGES = ['en-IN', 'hi-IN', 'kn-IN'] as const;
export type Language = (typeof LANGUAGES)[number];

export const VISUAL_STYLES = ['storybook', 'illustrated', 'editorial'] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

/** How many of a lesson's scenes get a generated clip, by style. */
export const ANIMATED_QUOTA: Record<VisualStyle, number> = {
  storybook: 1, illustrated: 2, editorial: 4,
};

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where a claim came from, precise enough to re-open the page.
 *
 * A fact without one of these cannot enter a scene. The textbook's reuse
 * rights are unresolved, so `figureRef` records that an official figure exists
 * on that page — it never means the figure was copied.
 */
export const SourceRefSchema = z.object({
  book: z.string().min(3).max(120),
  edition: z.string().regex(/^20\d\d-\d\d$/),
  page: z.number().int().min(1).max(999),
  figureRef: z.string().max(40).nullable(),
  url: z.string().url(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const FactSchema = z.object({
  claim: z.string().min(8).max(400),
  source: SourceRefSchema,
});

// ── Assets ──────────────────────────────────────────────────────────────────

/**
 * What produced an artefact, so a report can distinguish a rendered frame from
 * a generated one without inferring it from a filename.
 *
 * `placeholder` is deliberate and must survive into the output metadata: a
 * stand-in still is not an AI-generated picture, and a sample built from one
 * may never be described as though a model drew it.
 */
export const ProducerSchema = z.object({
  kind: z.enum(['model', 'deterministic', 'placeholder']),
  /** Model identity including its revision, e.g. `wan-2.2-ti2v-5b@fp16`. */
  name: z.string().min(2).max(80),
  host: z.enum(['local', 'external']),
});
export type Producer = z.infer<typeof ProducerSchema>;

export const AssetStatus = z.enum(['pending', 'running', 'ready', 'failed', 'skipped']);

const AssetBase = {
  /** Hash of exactly the inputs that determine this artefact. */
  cacheKey: z.string().regex(/^[0-9a-f]{16,64}$/),
  status: AssetStatus,
  producer: ProducerSchema.nullable(),
  path: z.string().nullable(),
  failureReason: z.string().max(300).nullable(),
};

export const KeyframeSchema = z.object({
  ...AssetBase,
  width: z.number().int().min(1920).nullable(),
  height: z.number().int().min(1080).nullable(),
  /** Vision check outcome. A keyframe is never animated until this is true. */
  approved: z.boolean(),
  approvalNote: z.string().max(300).nullable(),
});

export const ClipSchema = z.object({
  ...AssetBase,
  /** Wan latent length is 1 modulo 4; the worker rounds up to satisfy it. */
  frames: z.number().int().positive().nullable(),
  seconds: z.number().positive().nullable(),
});

export const AudioSchema = z.object({
  ...AssetBase,
  /** Measured from the PCM, never estimated from character count. */
  measuredSeconds: z.number().positive().nullable(),
  pace: z.enum(['natural', 'brisk']),
  /** True when the planner had to shorten the sentence to fit the slot. */
  rewritten: z.boolean(),
});

// ── Scenes ──────────────────────────────────────────────────────────────────

/**
 * One sentence, one picture, one slot.
 *
 * `narration` and `subtitle` are keyed by language rather than held in
 * parallel arrays, so a missing Kannada line is a missing key and not a
 * silently shorter array.
 */
export const SceneSchema = z.object({
  id: z.uuid(),
  index: z.number().int().min(1).max(8),

  objective: z.string().min(8).max(200),
  facts: z.array(FactSchema).min(1).max(4),

  /** Drawn by the compositor, never by a model. */
  caption: z.string().min(3).max(120),
  /** Storybook chapter banner; null for the other styles. */
  title: z.string().min(2).max(60).nullable(),
  overlay: z.unknown(),

  visualPrompt: z.string().min(10).max(1200),
  negativePrompt: z.string().min(10).max(800),
  motionPrompt: z.string().min(10).max(1200),
  motionMode: z.enum(['animate', 'still']),

  keyframe: KeyframeSchema,
  clip: ClipSchema.nullable(),

  // Partial by design: a lesson built only in English carries only `en-IN`,
  // and a Kannada line that has not been written yet is simply absent. `z.record`
  // over an enum demands every key, which would force empty strings into the
  // record and turn "not translated yet" into something indistinguishable from
  // "translated to nothing". Which languages are *required* is a property of
  // the lesson, not of the type, so `validateSpec` enforces it against the
  // spec's own `languages` list.
  narration: z.partialRecord(z.enum(LANGUAGES), z.string().min(5).max(400)),
  subtitle: z.partialRecord(z.enum(LANGUAGES), z.string().min(5).max(400)),
  audio: z.partialRecord(z.enum(LANGUAGES), AudioSchema),
});
export type Scene = z.infer<typeof SceneSchema>;

// ── Lesson ──────────────────────────────────────────────────────────────────

export const ValidationSchema = z.object({
  check: z.string().min(3).max(80),
  passed: z.boolean(),
  detail: z.string().max(300),
});

export const LessonSpecSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  lessonId: z.uuid(),

  curriculum: z.literal('KTBS'),
  classLevel: z.number().int().min(1).max(10),
  subject: z.string().min(2).max(60),
  chapter: z.string().min(2).max(160),
  topic: z.string().min(2).max(200),
  medium: z.string().min(2).max(30),
  book: SourceRefSchema,

  visualStyle: z.enum(VISUAL_STYLES),
  /** One seed family per lesson, so the four pictures look related. */
  seed: z.number().int().nonnegative(),
  /** The style contract prepended to every visual prompt in this lesson. */
  styleContract: z.string().min(20).max(800),

  scenes: z.array(SceneSchema).min(1).max(8),
  /** Languages this lesson is actually built for. */
  languages: z.array(z.enum(LANGUAGES)).min(1),

  modelVersions: z.record(z.string(), z.string()),
  pipelineVersion: z.string().min(1).max(40),
  validations: z.array(ValidationSchema),
  createdAt: z.iso.datetime(),
});
export type LessonSpec = z.infer<typeof LessonSpecSchema>;

// ── Derived timing ──────────────────────────────────────────────────────────

/**
 * When a scene starts and ends. Derived, never stored.
 *
 * Storing a start time alongside an index invites the two to disagree after a
 * reorder, and then a subtitle sits over the wrong picture.
 */
export function sceneSpan(scene: Scene): { start: number; end: number } {
  const start = (scene.index - 1) * SLOT_SECONDS;
  return { start, end: start + SLOT_SECONDS };
}

export function lessonSeconds(spec: LessonSpec): number {
  return spec.scenes.length * SLOT_SECONDS;
}

/**
 * Every rule a spec must satisfy before a single GPU second is spent on it.
 *
 * Returned rather than thrown, so a caller can show a teacher all the problems
 * at once instead of the first one.
 */
export function validateSpec(spec: LessonSpec): z.infer<typeof ValidationSchema>[] {
  const out: z.infer<typeof ValidationSchema>[] = [];
  const add = (check: string, passed: boolean, detail: string) =>
    out.push({ check, passed, detail });

  const seconds = lessonSeconds(spec);
  add('duration-cap', seconds <= MAX_LESSON_SECONDS,
    `${spec.scenes.length} scenes x ${SLOT_SECONDS}s = ${seconds}s, cap ${MAX_LESSON_SECONDS}s`);

  const indexes = spec.scenes.map((s) => s.index);
  add('scene-order', indexes.every((n, i) => n === i + 1),
    `indexes ${indexes.join(',')} must be 1..${spec.scenes.length} with no gaps`);

  add('scene-ids-unique', new Set(spec.scenes.map((s) => s.id)).size === spec.scenes.length,
    'every scene needs its own stable id');

  // A claim with no page cannot be checked by a teacher, so it cannot ship.
  const unsourced = spec.scenes.flatMap((s) =>
    s.facts.filter((f) => !f.source.page).map(() => s.index));
  add('facts-sourced', unsourced.length === 0,
    unsourced.length ? `scenes ${unsourced.join(',')} carry a claim with no page` : 'every claim cites a page');

  // A missing language is a missing key, and must be caught before assembly
  // rather than surfacing as a silent gap in the audio track.
  for (const lang of spec.languages) {
    const missing = spec.scenes.filter((s) => !s.narration[lang]).map((s) => s.index);
    add(`narration-${lang}`, missing.length === 0,
      missing.length ? `scenes ${missing.join(',')} have no ${lang} line` : `all scenes have ${lang}`);
  }

  // Narration that outruns its slot would play over the next picture.
  const overrun = spec.scenes.flatMap((s) =>
    spec.languages
      .map((lang) => ({ lang, a: s.audio[lang] }))
      .filter(({ a }) => a?.measuredSeconds != null && a.measuredSeconds > SLOT_SECONDS)
      .map(({ lang }) => `${s.index}/${lang}`));
  add('narration-fits', overrun.length === 0,
    overrun.length ? `over ${SLOT_SECONDS}s: ${overrun.join(', ')}` : `every measured line fits ${SLOT_SECONDS}s`);

  const quota = ANIMATED_QUOTA[spec.visualStyle];
  const animated = spec.scenes.filter((s) => s.motionMode === 'animate').length;
  add('animation-quota', animated <= quota,
    `${animated} animated, ${spec.visualStyle} allows ${quota}`);

  // The rule that keeps a wrong picture from becoming a clip.
  const unapproved = spec.scenes
    .filter((s) => s.motionMode === 'animate' && !s.keyframe.approved)
    .map((s) => s.index);
  add('animate-approved-only', unapproved.length === 0,
    unapproved.length ? `scenes ${unapproved.join(',')} would animate an unapproved keyframe` : 'all animated scenes passed the picture check');

  return out;
}

/** True when nothing blocks rendering. */
export function specIsRenderable(spec: LessonSpec): boolean {
  return validateSpec(spec).every((v) => v.passed);
}

/**
 * Whether this lesson contains any artefact a model did not produce.
 *
 * A sample built from stand-in stills must be reported as such. This is the
 * function a report calls rather than guessing from file paths.
 */
export function placeholderAssets(spec: LessonSpec): string[] {
  const out: string[] = [];
  for (const scene of spec.scenes) {
    if (scene.keyframe.producer?.kind === 'placeholder') out.push(`scene ${scene.index} keyframe`);
    if (scene.clip?.producer?.kind === 'placeholder') out.push(`scene ${scene.index} clip`);
    for (const lang of Object.keys(scene.audio) as Language[]) {
      if (scene.audio[lang]?.producer?.kind === 'placeholder') out.push(`scene ${scene.index} audio ${lang}`);
    }
  }
  return out;
}
