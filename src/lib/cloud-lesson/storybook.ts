import { z } from 'zod';

import {
  CLOUD_LESSON_CAMERA_MOVES,
  CLOUD_LESSON_SHOT_SIZES,
  CLOUD_LESSON_STORYBOOK_SHOTS,
  type CloudLessonPreparedScene,
  CloudLessonPreparedSceneSchema,
  cloudLessonStorybookAnimationCap,
} from '@/lib/videos/cloud-lesson-contracts';
import { usesEnglishProductionScript } from '@/lib/videos/languages';
import { PRINTED_MATTER, scrubLettering } from '@/lib/videos/planner';

/**
 * The storybook style's contracts: what the `cloud-lesson-storybook-director`
 * skill must return, how its answer is cleaned and checked in code, how it
 * becomes the scene list `complete_cloud_lesson_preparation` accepts, and what
 * the `cloud-lesson-storybook-checker` skill reports about a picture.
 *
 * Pure functions only — no model calls, no database — so the rules can be
 * tested offline and the prep and image workers share one copy of them.
 * The database enforces the same limits again (migration 20261011150000).
 */

// ── Director output ─────────────────────────────────────────────────────────

/** Words a storybook picture must not name: everything PRINTED_MATTER covers, plus the decorations that carry titles. */
const STORYBOOK_LETTERING = /\b(banners?|ribbons?|plaques?|placards?|emblems?|insignias?|calligraph\w*|signatures?)\b/i;
export const mentionsStorybookLettering = (text: string) => PRINTED_MATTER.test(text) || STORYBOOK_LETTERING.test(text);

const English = z.string().trim().refine(usesEnglishProductionScript, 'Write it in English');

const CAMERA_ALIASES: Record<string, (typeof CLOUD_LESSON_CAMERA_MOVES)[number]> = {
  push: 'push_in', pushin: 'push_in', zoomin: 'push_in', dollyin: 'push_in',
  pull: 'pull_out', pullout: 'pull_out', zoomout: 'pull_out', dollyout: 'pull_out',
  panleft: 'pan_left', panright: 'pan_right', tiltup: 'tilt_up', tiltdown: 'tilt_down',
};

/** "Push in", "zoom-in", "PAN_LEFT" → the camera move name the database stores. */
export function normalizeCameraMove(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  return CAMERA_ALIASES[key] ?? value.toLowerCase().trim().replace(/[\s-]+/g, '_');
}

/** "The Grand Bazaar." → "The Grand Bazaar". Quotes, trailing punctuation and extra spaces go. */
export function cleanChapterTitle(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/["“”‘’]/g, (quote) => (quote === '’' ? "'" : ''))
    .replace(/[.:;!?,–—-]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A shot's picture, with lettering-prone phrases rewritten first. */
const VisualSchema = z.preprocess(
  (value) => (typeof value === 'string' ? scrubLettering(value) : value),
  English.min(20).max(1200)
    .refine((text) => text.split(/\s+/).length <= 120, 'Describe the picture in at most 90 words')
    .refine((text) => !mentionsStorybookLettering(text),
      'Name no writing or objects that carry it (books, scrolls, maps, banners, signs, coins, flags with emblems)'),
);

export const StorybookShotSchema = z.object({
  shotSize: z.enum(CLOUD_LESSON_SHOT_SIZES),
  cameraMove: z.preprocess(normalizeCameraMove, z.enum(CLOUD_LESSON_CAMERA_MOVES)),
  visualDescription: VisualSchema,
});
export type StorybookShot = z.infer<typeof StorybookShotSchema>;

export const StorybookDirectedSceneSchema = z.object({
  index: z.number().int().min(1).max(8),
  title: z.preprocess(cleanChapterTitle, English.min(2).max(60)
    .refine((text) => !/[\p{N}=+*/^<>%×÷]/u.test(text), 'No digits or symbols in a chapter title')
    .refine((text) => text.split(/\s+/).length <= 5, 'A chapter title is 2-4 words')),
  motionMode: z.enum(['animate', 'still']),
  motionDescription: English.min(15).max(800)
    .refine((text) => /Start\s*:[\s\S]+Then\s*:[\s\S]+End\s*:[\s\S]+/i.test(text), 'Write it as "Start: ... Then: ... End: ..."')
    .refine((text) => !mentionsStorybookLettering(text), 'Do not introduce writing in the animation'),
  shots: z.array(StorybookShotSchema).min(CLOUD_LESSON_STORYBOOK_SHOTS.min).max(CLOUD_LESSON_STORYBOOK_SHOTS.max),
});
export type StorybookDirectedScene = z.infer<typeof StorybookDirectedSceneSchema>;

const fingerprint = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The director's whole answer for a lesson of `sceneCount` scenes. Checked in
 * code: scene order, no picture used twice anywhere in the lesson, and no
 * scene with two shots of the same size (the shot list has to move).
 */
export function storybookDirectionSchema(sceneCount: number) {
  return z.object({
    visualBible: English.min(20).max(500),
    scenes: z.array(StorybookDirectedSceneSchema).length(sceneCount),
  }).superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.scenes.forEach((scene, position) => {
      if (scene.index !== position + 1) {
        ctx.addIssue({ code: 'custom', path: ['scenes', position, 'index'], message: `Expected scene index ${position + 1}` });
      }
      const sizes = scene.shots.map((shot) => shot.shotSize);
      if (new Set(sizes).size !== sizes.length) {
        ctx.addIssue({ code: 'custom', path: ['scenes', position, 'shots'], message: 'Give each shot of a scene a different shot size' });
      }
      scene.shots.forEach((shot, shotPosition) => {
        const key = fingerprint(shot.visualDescription);
        if (seen.has(key)) {
          ctx.addIssue({ code: 'custom', path: ['scenes', position, 'shots', shotPosition, 'visualDescription'], message: 'Every shot needs a new picture' });
        }
        seen.add(key);
      });
    });
  });
}
export type StorybookDirection = z.infer<ReturnType<typeof storybookDirectionSchema>>;

// ── Into the scene list the database accepts ────────────────────────────────

/** One storybook scene as `complete_cloud_lesson_preparation` receives it. */
export const CloudLessonStorybookSceneSchema = CloudLessonPreparedSceneSchema.extend({
  title: z.string().trim().min(2).max(60),
  shots: z.array(StorybookShotSchema).min(CLOUD_LESSON_STORYBOOK_SHOTS.min).max(CLOUD_LESSON_STORYBOOK_SHOTS.max),
}).refine((scene) => scene.visualDescription === scene.shots[0].visualDescription,
  "A storybook scene's visual is its first shot");
export type CloudLessonStorybookScene = z.infer<typeof CloudLessonStorybookSceneSchema>;

export interface StorybookMerge {
  scenes: CloudLessonStorybookScene[];
  /** Scenes the director marked `animate` beyond the cap, made `still`. */
  demotedToStill: number[];
}

/**
 * Joins the audited, translated scene text with the director's shots.
 * Enforces the animation cap in scene order (the database refuses more) and
 * makes each scene's visual its first shot, which is the picture Higgsfield
 * animates and the one the chapter title is drawn over.
 */
export function mergeStorybookScenes(
  written: Omit<CloudLessonPreparedScene, 'visualDescription' | 'motionDescription' | 'motionMode'>[],
  direction: StorybookDirection,
): StorybookMerge {
  if (written.length !== direction.scenes.length) {
    throw new Error(`Storybook direction has ${direction.scenes.length} scenes for a ${written.length}-scene lesson`);
  }
  const cap = cloudLessonStorybookAnimationCap(written.length);
  let animated = 0;
  const demotedToStill: number[] = [];
  const scenes = written.map((scene, position) => {
    const directed = direction.scenes[position];
    let motionMode = directed.motionMode;
    if (motionMode === 'animate') {
      animated += 1;
      if (animated > cap) {
        motionMode = 'still';
        demotedToStill.push(scene.index);
      }
    }
    return CloudLessonStorybookSceneSchema.parse({
      ...scene,
      title: directed.title,
      visualDescription: directed.shots[0].visualDescription,
      motionDescription: directed.motionDescription,
      motionMode,
      shots: directed.shots,
    });
  });
  return { scenes, demotedToStill };
}

/** Pictures a storybook lesson will generate: one per shot. */
export const storybookShotCount = (direction: StorybookDirection) =>
  direction.scenes.reduce((total, scene) => total + scene.shots.length, 0);

// ── Picture checker output ──────────────────────────────────────────────────

export const StorybookVerdictSchema = z.object({
  showsSubject: z.boolean(),
  singlePhoto: z.boolean(),
  hasWriting: z.boolean(),
  matchesStyle: z.boolean(),
  unsafe: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});
export type StorybookVerdict = z.infer<typeof StorybookVerdictSchema>;

export interface StorybookShotDecision {
  verdict: StorybookVerdict;
  accept: boolean;
  /** Accepted only because no attempt is left; recorded as a warning. */
  acceptedOnFinalAttempt: boolean;
  problems: string[];
}

/**
 * Writing in a picture and unsafe imagery are never accepted. Everything else
 * (off-subject, a framed or split picture, a drift from the engraving look)
 * is regenerated while attempts remain, and tolerated on the last one so a
 * single picture cannot fail a whole lesson.
 */
export function decideStorybookShot(verdict: StorybookVerdict, finalAttempt: boolean): StorybookShotDecision {
  const problems = [
    !verdict.showsSubject && 'subject not shown',
    !verdict.singlePhoto && 'not a single full-frame picture',
    verdict.hasWriting && 'writing visible',
    !verdict.matchesStyle && 'not in the engraving style',
    verdict.unsafe && 'unsafe for students',
  ].filter((problem): problem is string => Boolean(problem));
  if (problems.length === 0) return { verdict, accept: true, acceptedOnFinalAttempt: false, problems };
  const accept = finalAttempt && !verdict.hasWriting && !verdict.unsafe;
  return { verdict, accept, acceptedOnFinalAttempt: accept, problems };
}
