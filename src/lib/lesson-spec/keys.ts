/**
 * Content-addressed keys, so editing one thing re-runs only what depends on it.
 *
 * Each key hashes exactly the inputs that determine its artefact and nothing
 * else. Including a field that does not change the output — a timestamp, the
 * lesson id, the teacher's name — would make every key unique and quietly turn
 * the cache off. Omitting one that does change the output is worse: a stale
 * picture would be served for a prompt that no longer describes it.
 *
 * The chain is keyframe → clip → scene → lesson, with audio joining at the
 * scene. A caption edit therefore reaches `sceneKey` but not `keyframeKey`,
 * which is the whole point: FFmpeg re-runs, the GPU does not.
 */

/**
 * STATUS, 2026-10-23: no production consumer.
 *
 * These keys are covered by `npm run test:lesson-spec` and are imported by
 * nothing else. Reuse in the running system is decided elsewhere and by
 * different means, which is worth knowing before assuming this module is on
 * the path:
 *
 *   - lesson level: `reserve_cloud_lesson` matches on `content_key`,
 *     `visual_style`, `language_code`, `generator_version` and friends.
 *   - keyframe level: `cloud_lesson_reusable_keyframe` matches a scene's
 *     stored `image_prompt`.
 *   - clip level: `cloud_lesson_reusable_clip` matches the motion prompt and
 *     the keyframe it animated.
 *
 * All three live in SQL, so the decision happens where the candidate rows
 * are and stays one indexed query. Content-addressed keys computed in
 * TypeScript would need a column to compare against before they could
 * replace any of that.
 *
 * Kept rather than deleted because `LessonSpec` is the canonical shape the
 * pipeline is moving towards, and these are its identity functions. But
 * nothing here affects a running lesson today.
 */

import { createHash } from 'node:crypto';

import type { Language, LessonSpec, Scene } from './schema';

/**
 * Field order is part of the key, so every call site must build the parts the
 * same way. Hashing a joined string rather than an object avoids depending on
 * JSON key order, which is not guaranteed across engines.
 */
function digest(parts: readonly (string | number | boolean | null)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part));
    hash.update('\u0000');          // separator, so ["ab","c"] ≠ ["a","bc"]
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * The picture. Depends on what to draw and who draws it — never on the
 * caption, which is composited on top long afterwards.
 */
export function keyframeKey(spec: LessonSpec, scene: Scene): string {
  return digest([
    spec.specVersion, spec.styleContract, spec.visualStyle,
    scene.visualPrompt, scene.negativePrompt,
    spec.seed + scene.index,
    spec.modelVersions.image ?? 'unset',
  ]);
}

/** The clip. Built from an approved keyframe, so it inherits that key. */
export function clipKey(spec: LessonSpec, scene: Scene): string {
  return digest([
    keyframeKey(spec, scene),
    scene.motionPrompt, scene.negativePrompt, scene.motionMode,
    spec.modelVersions.motion ?? 'unset',
  ]);
}

/**
 * One language's narration for one scene.
 *
 * Voice and pace belong here because they change the waveform. The scene's
 * caption does not, because it is never spoken.
 */
export function audioKey(
  spec: LessonSpec, scene: Scene, language: Language,
  voice: string, pace: 'natural' | 'brisk',
): string {
  return digest([
    spec.specVersion,
    scene.narration[language] ?? '',
    language, voice, pace,
    spec.modelVersions.speech ?? 'unset',
  ]);
}

/**
 * The composited scene: picture plus chrome plus one language's audio.
 *
 * This is where caption, title and overlay enter the chain, and why a wording
 * fix costs one FFmpeg render rather than a keyframe and a clip.
 */
export function sceneKey(
  spec: LessonSpec, scene: Scene, language: Language,
  voice: string, pace: 'natural' | 'brisk',
): string {
  return digest([
    scene.motionMode === 'animate' ? clipKey(spec, scene) : keyframeKey(spec, scene),
    audioKey(spec, scene, language, voice, pace),
    scene.caption, scene.title ?? '', JSON.stringify(scene.overlay ?? null),
    spec.visualStyle, language,
    spec.pipelineVersion,
  ]);
}

/** The finished file: every scene in order, for one language. */
export function lessonKey(
  spec: LessonSpec, language: Language,
  voice: string, pace: 'natural' | 'brisk',
): string {
  return digest([
    spec.specVersion, spec.pipelineVersion, language,
    ...spec.scenes.map((scene) => sceneKey(spec, scene, language, voice, pace)),
  ]);
}

/**
 * What a change actually invalidates.
 *
 * Used by the editor to tell a teacher the cost of an edit before they commit
 * to it — and used by tests to prove that a caption fix does not reach the
 * keyframe.
 */
export interface Invalidation {
  keyframes: number[];
  clips: number[];
  audio: string[];
  scenes: number[];
  lesson: boolean;
}

export function diffSpecs(
  before: LessonSpec, after: LessonSpec,
  language: Language, voice: string, pace: 'natural' | 'brisk',
): Invalidation {
  const out: Invalidation = { keyframes: [], clips: [], audio: [], scenes: [], lesson: false };
  const previous = new Map(before.scenes.map((scene) => [scene.id, scene]));

  for (const scene of after.scenes) {
    const old = previous.get(scene.id);
    // A scene with no counterpart is new, so everything about it is new.
    if (!old) {
      out.keyframes.push(scene.index);
      if (scene.motionMode === 'animate') out.clips.push(scene.index);
      out.audio.push(`${scene.index}/${language}`);
      out.scenes.push(scene.index);
      continue;
    }
    if (keyframeKey(before, old) !== keyframeKey(after, scene)) out.keyframes.push(scene.index);
    if (scene.motionMode === 'animate' && clipKey(before, old) !== clipKey(after, scene)) {
      out.clips.push(scene.index);
    }
    if (audioKey(before, old, language, voice, pace) !== audioKey(after, scene, language, voice, pace)) {
      out.audio.push(`${scene.index}/${language}`);
    }
    if (sceneKey(before, old, language, voice, pace) !== sceneKey(after, scene, language, voice, pace)) {
      out.scenes.push(scene.index);
    }
  }

  out.lesson = lessonKey(before, language, voice, pace) !== lessonKey(after, language, voice, pace);
  return out;
}
