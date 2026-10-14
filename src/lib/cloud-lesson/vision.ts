import 'server-only';

import { z } from 'zod';

import { type CallOptions, generateStructuredWithImage } from './gemini';
import type { CostMeter } from './pricing';
import { loadCloudLessonSkill } from './skills';
import { decideStorybookShot, type StorybookShotDecision, StorybookVerdictSchema } from './storybook';

/**
 * The keyframe gate. Before a picture is paid for again — animated by
 * Higgsfield or used as the style reference for the rest of the lesson — the
 * `cloud-lesson-keyframe-checker` skill looks at it. A failing picture is
 * regenerated; on the job's last attempt a picture that is merely off-subject
 * is accepted with a warning so one scene never fails a lesson, but writing in
 * the image is never accepted, and unsafe imagery never is.
 */

export const KeyframeVerdictSchema = z.object({
  showsSubject: z.boolean(),
  singlePhoto: z.boolean(),
  hasWriting: z.boolean(),
  unsafe: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});
export type KeyframeVerdict = z.infer<typeof KeyframeVerdictSchema>;

export interface KeyframeDecision {
  verdict: KeyframeVerdict;
  /** Use this picture. */
  accept: boolean;
  /** Accepted only because it was the last attempt; recorded as a warning. */
  acceptedOnFinalAttempt: boolean;
  problems: string[];
}

export function decideKeyframe(verdict: KeyframeVerdict, finalAttempt: boolean): KeyframeDecision {
  const problems = [
    !verdict.showsSubject && 'subject not shown',
    !verdict.singlePhoto && 'not a single photograph',
    verdict.hasWriting && 'writing visible',
    verdict.unsafe && 'unsafe for students',
  ].filter((problem): problem is string => Boolean(problem));
  if (problems.length === 0) return { verdict, accept: true, acceptedOnFinalAttempt: false, problems };
  const neverAcceptable = verdict.unsafe || verdict.hasWriting;
  const accept = finalAttempt && !neverAcceptable;
  return { verdict, accept, acceptedOnFinalAttempt: accept, problems };
}

export interface CheckKeyframeOptions extends Omit<CallOptions, 'stage'> {
  image: { mimeType: string; data: Buffer };
  /** The scene's intended picture — its visual description. */
  description: string;
  finalAttempt: boolean;
  meter?: CostMeter;
}

export async function checkKeyframe(options: CheckKeyframeOptions): Promise<KeyframeDecision> {
  const skill = await loadCloudLessonSkill('cloud-lesson-keyframe-checker');
  const { data } = await generateStructuredWithImage({
    ...options,
    skill,
    values: {},
    schema: KeyframeVerdictSchema,
    userPrompt: `Intended description of this scene's photograph:\n${options.description.slice(0, 1200)}\n\nCheck the image above.`,
    maxAttempts: 2,
  });
  return decideKeyframe(data, options.finalAttempt);
}

/**
 * The storybook style's gate: `cloud-lesson-storybook-checker` judges one shot
 * of an engraving-style lesson, including whether it kept the engraving look.
 * Writing and unsafe imagery are never accepted; see decideStorybookShot.
 */
export async function checkStorybookShot(options: CheckKeyframeOptions): Promise<StorybookShotDecision> {
  const skill = await loadCloudLessonSkill('cloud-lesson-storybook-checker');
  const { data } = await generateStructuredWithImage({
    ...options,
    skill,
    values: {},
    schema: StorybookVerdictSchema,
    userPrompt: `Intended description of this shot:\n${options.description.slice(0, 1200)}\n\nCheck the image above.`,
    maxAttempts: 2,
  });
  return decideStorybookShot(data, options.finalAttempt);
}
