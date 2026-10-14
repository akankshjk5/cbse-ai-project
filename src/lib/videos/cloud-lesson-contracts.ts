import { z } from 'zod';

import type { Tables } from '@/lib/supabase/types';
import { VIDEO_LANGUAGES } from '@/lib/videos/languages';

/**
 * Contracts for the CLOUD lesson engine (Gemini + Higgsfield).
 *
 * This engine is separate from the RunPod narrated-lesson engine in
 * `lesson-contracts.ts`: it has its own tables (`cloud_lesson_*`), its own RPCs,
 * its own storage bucket and its own workers. Nothing here is imported by the
 * RunPod path, and nothing from the RunPod path's contracts is reused, so either
 * engine can change without the other noticing.
 *
 * Mirrors supabase/migrations/20261010120000_cloud_lesson_engine.sql. When that
 * schema changes, change this file in the same commit.
 */

/** The cloud engine ships three languages; the database refuses any other. */
export const CLOUD_LESSON_LANGUAGE_CODES = ['en-IN', 'hi-IN', 'kn-IN'] as const;
export type CloudLessonLanguageCode = (typeof CLOUD_LESSON_LANGUAGE_CODES)[number];

/** The shared language catalogue, narrowed to what the cloud engine offers. */
export const CLOUD_LESSON_LANGUAGES = VIDEO_LANGUAGES.filter(
  (language): language is Extract<(typeof VIDEO_LANGUAGES)[number], { code: CloudLessonLanguageCode }> =>
    (CLOUD_LESSON_LANGUAGE_CODES as readonly string[]).includes(language.code),
);

/** Both durations use exact 7.5-second scene slots. */
export const CLOUD_LESSON_DURATION_SECONDS = 60;
export const CLOUD_LESSON_SCENE_COUNT = 8;
export const CLOUD_LESSON_SCENE_SECONDS = CLOUD_LESSON_DURATION_SECONDS / CLOUD_LESSON_SCENE_COUNT;
/** Styles a teacher may choose. `storybook` joined once its prep, image and media workers shipped (S1-S6). */
export const CLOUD_LESSON_VISUAL_STYLES = ['illustrated', 'editorial', 'storybook'] as const;
/**
 * Every style the database accepts. Kept as its own list so a style can be
 * stored (and its rows parsed) before it is offered, as storybook was.
 */
export const CLOUD_LESSON_STORED_VISUAL_STYLES = ['illustrated', 'editorial', 'storybook'] as const;
export type CloudLessonStoredVisualStyle = (typeof CLOUD_LESSON_STORED_VISUAL_STYLES)[number];

/**
 * Storybook: shots per scene, the shot sizes and camera moves a shot may use,
 * and its animation cap. Exactly 2 shots per scene keeps the picture bill
 * predictable (the database still accepts 3, for lessons planned before).
 */
export const CLOUD_LESSON_STORYBOOK_SHOTS = { min: 2, max: 2 } as const;
export const CLOUD_LESSON_SHOT_SIZES = ['wide', 'medium', 'close', 'detail'] as const;
export const CLOUD_LESSON_CAMERA_MOVES = ['push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down'] as const;
/** Mirrors private.cloud_lesson_storybook_animation_cap: 2 of 8 scenes, 1 of 4. */
export const cloudLessonStorybookAnimationCap = (sceneCount: number) => (sceneCount <= 4 ? 1 : 2);
export const cloudLessonSceneCount = (durationSeconds = 60) => durationSeconds / CLOUD_LESSON_SCENE_SECONDS;

/** What a teacher reads about each style, in the form and on a lesson. */
export const CLOUD_LESSON_STYLE_COPY: Record<CloudLessonStoredVisualStyle, { label: string; description: string }> = {
  illustrated: { label: '2D illustrated explainer', description: 'Clean illustrations, bold outlines, animated teaching overlays and smooth reveals.' },
  editorial: { label: 'Editorial photographs', description: 'Photographic scenes with a warm paper presentation.' },
  storybook: { label: 'Storybook', description: 'Pen-and-ink engravings, two pictures a scene, chapter titles and a storyteller voice.' },
};

/** Most scenes a lesson may animate, mirroring the database caps for each style. */
export function cloudLessonAnimationCap(style: CloudLessonStoredVisualStyle, durationSeconds: 30 | 60): number {
  if (style === 'storybook') return cloudLessonStorybookAnimationCap(cloudLessonSceneCount(durationSeconds));
  if (style === 'illustrated') return durationSeconds === 30 ? 2 : 3;
  return durationSeconds === 30 ? 4 : 6;
}

/** Pictures a lesson draws: one per scene, or one per storybook shot. */
export const cloudLessonPictureCount = (style: CloudLessonStoredVisualStyle | undefined, durationSeconds: number) =>
  cloudLessonSceneCount(durationSeconds) * (style === 'storybook' ? CLOUD_LESSON_STORYBOOK_SHOTS.max : 1);

/**
 * Measured storybook costs (live smoke, October 2026): the plan, the voice per
 * 30 seconds, and one 2K picture with its check. Re-measure with
 * `npm run smoke:cloud-storybook` when the models change.
 */
export const CLOUD_LESSON_STORYBOOK_COSTS = { planUsd: 0.035, voiceUsdPer30s: 0.006, pictureUsd: 0.061 } as const;
/** A storybook lesson's expected bill before retries, given the Higgsfield rate per second. */
export function cloudLessonStorybookEstimateUsd(durationSeconds: 30 | 60, usdPerAnimationSecond: number): number {
  const { planUsd, voiceUsdPer30s, pictureUsd } = CLOUD_LESSON_STORYBOOK_COSTS;
  return planUsd + voiceUsdPer30s * (durationSeconds / 30) + pictureUsd * cloudLessonPictureCount('storybook', durationSeconds)
    + cloudLessonAnimationCap('storybook', durationSeconds) * 5 * usdPerAnimationSecond;
}

/**
 * Per-teacher limits. The CONTROL is `reserve_cloud_lesson` in Postgres, which
 * counts and inserts under one advisory lock; these copies exist only so the
 * form can explain a refusal. Change both together.
 */
export const CLOUD_LESSON_LIMITS = {
  /** Lessons a teacher may have generating at once. */
  active: 2,
  /** Lessons a teacher may start in any rolling 24 hours (cancelled ones count). */
  perDay: 10,
} as const;

/** Hints `reserve_cloud_lesson` attaches to its refusals, for the API to map. */
export const CLOUD_LESSON_REFUSAL_HINTS = [
  'cloud_lesson_auth',
  'cloud_lesson_invalid',
  'cloud_lesson_active_limit',
  'cloud_lesson_daily_limit',
] as const;
export type CloudLessonRefusalHint = (typeof CLOUD_LESSON_REFUSAL_HINTS)[number];

// ── Requests ────────────────────────────────────────────────────────────────

export const CreateCloudLessonSchema = z.object({
  classLevel: z.number().int().min(1).max(12),
  subject: z.string().trim().min(2).max(100),
  topic: z.string().trim().min(3).max(300),
  languageCode: z.enum(CLOUD_LESSON_LANGUAGE_CODES).default('en-IN'),
  durationSeconds: z.union([z.literal(30), z.literal(60)]).default(60),
  visualStyle: z.enum(CLOUD_LESSON_VISUAL_STYLES).default('illustrated'),
});
export type CreateCloudLessonInput = Omit<z.infer<typeof CreateCloudLessonSchema>, 'durationSeconds' | 'visualStyle'> & {
  durationSeconds?: 30 | 60; visualStyle?: (typeof CLOUD_LESSON_VISUAL_STYLES)[number];
};

/**
 * What a prep worker reads back from a stored lesson: the request, with every
 * style the database accepts. The API and the teacher's form use
 * CreateCloudLessonSchema, so a style is only offered once its workers exist.
 */
export const PrepareCloudLessonInputSchema = CreateCloudLessonSchema.extend({
  visualStyle: z.enum(CLOUD_LESSON_STORED_VISUAL_STYLES).default('illustrated'),
});
export type PrepareCloudLessonInput = Omit<z.infer<typeof PrepareCloudLessonInputSchema>, 'durationSeconds' | 'visualStyle'> & {
  durationSeconds?: 30 | 60; visualStyle?: CloudLessonStoredVisualStyle;
};

// ── Rows ────────────────────────────────────────────────────────────────────

export const CloudLessonStatusSchema = z.enum([
  'preparing',
  'generating_images',
  'generating_videos',
  'assembling',
  'succeeded',
  'failed',
  'cancelled',
]);
export type CloudLessonStatus = z.infer<typeof CloudLessonStatusSchema>;

export const CLOUD_LESSON_ACTIVE_STATUSES: readonly CloudLessonStatus[] = [
  'preparing',
  'generating_images',
  'generating_videos',
  'assembling',
];

export const CloudLessonSceneStatusSchema = z.enum([
  'queued_image',
  'generating_image',
  'queued_video',
  'generating_video',
  'succeeded',
  'failed',
  'cancelled',
]);

/** `animate` pays for a Higgsfield clip; `still` gets the compositor's camera move. */
export const CloudLessonMotionModeSchema = z.enum(['animate', 'still']);
export type CloudLessonMotionMode = z.infer<typeof CloudLessonMotionModeSchema>;

export const CloudLessonJobKindSchema = z.enum(['prepare', 'image', 'video', 'assemble']);
export type CloudLessonJobKind = z.infer<typeof CloudLessonJobKindSchema>;

export const CloudLessonJobStatusSchema = z.enum([
  'queued',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);

/** Spend per job kind, in USD, as the workers record it. */
export const CloudLessonCostBreakdownSchema = z.object({
  prepare: z.coerce.number().optional(),
  image: z.coerce.number().optional(),
  video: z.coerce.number().optional(),
  assemble: z.coerce.number().optional(),
}).catchall(z.coerce.number());

export const CloudLessonProjectSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string(),
  class_level: z.number().int(),
  subject: z.string(),
  topic: z.string(),
  language_code: z.enum(CLOUD_LESSON_LANGUAGE_CODES),
  target_duration_seconds: z.union([z.literal(30), z.literal(60)]),
  visual_style: z.enum(CLOUD_LESSON_STORED_VISUAL_STYLES).optional(),
  title: z.string().nullable(),
  learning_objective: z.string().nullable(),
  narration_text: z.string().nullable(),
  narration_url: z.string().nullable(),
  narration_duration_seconds: z.coerce.number().nullable(),
  status: CloudLessonStatusSchema,
  final_video_url: z.string().nullable(),
  error_message: z.string().nullable(),
  cost_usd: z.coerce.number(),
  cost_breakdown: CloudLessonCostBreakdownSchema,
  cache_key: z.string().nullable(),
  content_key: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  reused_from_project_id: z.string().uuid().nullable().optional(),
});
export type CloudLessonProject = z.infer<typeof CloudLessonProjectSchema>;

export const CloudLessonSceneSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  scene_index: z.number().int(),
  duration_seconds: z.coerce.number(),
  fact: z.string(),
  narration: z.string(),
  caption: z.string(),
  overlay: z.record(z.string(), z.unknown()),
  visual_description: z.string(),
  motion_description: z.string(),
  motion_mode: CloudLessonMotionModeSchema,
  image_prompt: z.string(),
  video_prompt: z.string(),
  status: CloudLessonSceneStatusSchema,
  image_url: z.string().nullable(),
  video_url: z.string().nullable(),
  /** Storybook chapter title; null for the other styles. */
  title: z.string().nullable().optional(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type CloudLessonScene = z.infer<typeof CloudLessonSceneSchema>;

/** One picture of a storybook scene (`cloud_lesson_shots`). */
export const CloudLessonShotSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  scene_id: z.string().uuid(),
  shot_index: z.number().int().min(1).max(3),
  shot_size: z.enum(CLOUD_LESSON_SHOT_SIZES),
  camera_move: z.enum(CLOUD_LESSON_CAMERA_MOVES),
  visual_description: z.string(),
  image_prompt: z.string(),
  status: z.enum(['queued', 'succeeded', 'failed', 'cancelled']),
  image_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type CloudLessonShot = z.infer<typeof CloudLessonShotSchema>;

/** Job columns safe to show a teacher: no worker ids, prompts or provider ids. */
export const CLOUD_LESSON_JOB_PUBLIC_COLUMNS =
  'id, kind, scene_id, status, progress, attempts, max_attempts, started_at, completed_at, error_message';

export const CloudLessonJobProgressSchema = z.object({
  id: z.string().uuid(),
  kind: CloudLessonJobKindSchema,
  scene_id: z.string().uuid().nullable(),
  status: CloudLessonJobStatusSchema,
  progress: z.number().int(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type CloudLessonJobProgress = z.infer<typeof CloudLessonJobProgressSchema>;

// ── The prepare job's output ────────────────────────────────────────────────
// What a prep worker hands to `complete_cloud_lesson_preparation` as p_scenes.
// Validated in code before the call; the database re-checks lengths and kinds.

export const CloudLessonPreparedSceneSchema = z.object({
  index: z.number().int().min(1).max(CLOUD_LESSON_SCENE_COUNT),
  fact: z.string().trim().min(10).max(500),
  narration: z.string().trim().min(5).max(800),
  caption: z.string().trim().max(120),
  overlay: z.object({ kind: z.enum(['none', 'arrow', 'equation', 'groups', 'bars', 'timeline']) }).passthrough(),
  visualDescription: z.string().trim().min(20).max(1200),
  motionDescription: z.string().trim().min(15).max(800),
  motionMode: CloudLessonMotionModeSchema,
});
export type CloudLessonPreparedScene = z.infer<typeof CloudLessonPreparedSceneSchema>;

export const CloudLessonPreparedScenesSchema = z
  .array(CloudLessonPreparedSceneSchema)
  .refine(scenes => scenes.length === 4 || scenes.length === 8, 'Expected four or eight scenes')
  .superRefine((scenes, ctx) => {
    scenes.forEach((scene, position) => {
      if (scene.index !== position + 1) {
        ctx.addIssue({ code: 'custom', path: [position, 'index'], message: `Expected scene index ${position + 1}` });
      }
    });
  });

// ── Compile-time checks against the generated database types ───────────────
// If the schema and these contracts drift, `npm run typecheck` fails here.

type Assert<T extends true> = T;
type Covers<Row, Parsed> = keyof Row extends keyof Parsed ? true : false;
export type _CloudProjectCovered = Assert<Covers<Tables<'cloud_lesson_projects'>, CloudLessonProject>>;
export type _CloudSceneCovered = Assert<Covers<Tables<'cloud_lesson_scenes'>, CloudLessonScene>>;
export type _CloudShotCovered = Assert<Covers<Tables<'cloud_lesson_shots'>, CloudLessonShot>>;
