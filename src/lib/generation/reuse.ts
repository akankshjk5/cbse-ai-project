/**
 * Whether an existing lesson may be reused, and which of its stages survive.
 *
 * One implementation, shared by both execution paths. The rule lives here as a
 * pure function and is mirrored by `reserve_lesson` in Postgres, which holds
 * the advisory lock that makes concurrent requests safe. The database is the
 * control — a check in TypeScript cannot stop two requests racing — but the
 * two must agree about what "compatible" means, which is what this module and
 * its tests exist to pin down.
 *
 * Two things this is deliberately not:
 *
 *  - It is not a similarity search. Reuse is an exact match on every dimension
 *    in `CompatibilityKey`. Two topics that read alike are two lessons; a
 *    threshold on a similarity score would eventually serve a Class 9 lesson to
 *    a Class 10 class and nobody would know why.
 *  - It is not a cache of whatever finished last. A source must be *validated*:
 *    every scene succeeded, every asset present, every animated scene backed by
 *    a real clip. A half-finished lesson that happens to carry the right key is
 *    the most dangerous thing in a reuse system, because it looks like a hit.
 */

/**
 * Everything that must match before one lesson may stand in for another.
 *
 * Adding a field here retires every cached lesson that predates it, which is
 * the point: a dimension that cannot invalidate is a dimension that will
 * eventually serve stale content.
 */
export interface CompatibilityKey {
  curriculum: string;
  classLevel: number;
  subject: string;
  chapter: string | null;
  topic: string;
  language: string;
  difficulty: string;
  durationSeconds: number;
  visualStyle: string;
  /** The lesson schema's own version — bumped when scene shape changes. */
  contentVersion: string;
  /** The orchestration that produced it — prompts, stage order, caps. */
  pipelineVersion: string;
  /** Model identity per stage, so swapping a model retires its output. */
  modelVersions: Readonly<Record<string, string>>;
}

/** Free text differing only in case or spacing is the same topic. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A stable string for the whole key.
 *
 * Model versions are sorted by stage name so that two keys built in different
 * orders hash identically — otherwise reuse would depend on object key order,
 * which is a bug that only shows up under load.
 */
export function compatibilityKey(key: CompatibilityKey): string {
  const models = Object.keys(key.modelVersions).sort()
    .map((stage) => `${stage}=${key.modelVersions[stage]}`).join(',');
  return [
    key.curriculum, key.classLevel, normalise(key.subject),
    key.chapter === null ? '' : normalise(key.chapter), normalise(key.topic),
    key.language, key.difficulty, key.durationSeconds, key.visualStyle,
    key.contentVersion, key.pipelineVersion, models,
  ].join('|');
}

export type Incompatibility =
  | 'curriculum' | 'class' | 'subject' | 'chapter' | 'topic' | 'language'
  | 'difficulty' | 'duration' | 'style' | 'content-version' | 'pipeline-version'
  | `model:${string}`;

/** Every dimension on which two lessons differ. Empty means interchangeable. */
export function incompatibilities(a: CompatibilityKey, b: CompatibilityKey): Incompatibility[] {
  const out: Incompatibility[] = [];
  if (a.curriculum !== b.curriculum) out.push('curriculum');
  if (a.classLevel !== b.classLevel) out.push('class');
  if (normalise(a.subject) !== normalise(b.subject)) out.push('subject');
  const chapterA = a.chapter === null ? null : normalise(a.chapter);
  const chapterB = b.chapter === null ? null : normalise(b.chapter);
  if (chapterA !== chapterB) out.push('chapter');
  if (normalise(a.topic) !== normalise(b.topic)) out.push('topic');
  if (a.language !== b.language) out.push('language');
  if (a.difficulty !== b.difficulty) out.push('difficulty');
  if (a.durationSeconds !== b.durationSeconds) out.push('duration');
  if (a.visualStyle !== b.visualStyle) out.push('style');
  if (a.contentVersion !== b.contentVersion) out.push('content-version');
  if (a.pipelineVersion !== b.pipelineVersion) out.push('pipeline-version');
  const stages = new Set([...Object.keys(a.modelVersions), ...Object.keys(b.modelVersions)]);
  for (const stage of [...stages].sort()) {
    if (a.modelVersions[stage] !== b.modelVersions[stage]) out.push(`model:${stage}`);
  }
  return out;
}

export const isCompatible = (a: CompatibilityKey, b: CompatibilityKey): boolean =>
  incompatibilities(a, b).length === 0;

/** A candidate source, as the database rows describe it. */
export interface SourceLesson {
  lessonId: string;
  key: CompatibilityKey;
  status: string;
  /** Null until the lesson finished; a source without one is not finished. */
  completedAt: string | null;
  /** True only when the plan passed its own factual and format checks. */
  planValidated: boolean;
  sceneCount: number;
  expectedSceneCount: number;
  scenes: readonly SourceScene[];
}

export interface SourceScene {
  sceneIndex: number;
  status: string;
  imageUrl: string | null;
  motionMode: 'animate' | 'still';
  /** The provider clip, for an animated scene. Null means it was never made. */
  rawVideoUrl: string | null;
}

export type RejectionReason =
  | 'not-succeeded' | 'not-completed' | 'plan-unvalidated' | 'scene-count'
  | 'scene-not-succeeded' | 'missing-image' | 'missing-clip' | 'incompatible';

export interface ReuseDecision {
  reusable: boolean;
  reasons: RejectionReason[];
  incompatibilities: Incompatibility[];
}

/**
 * Whether a source may be reused for a request.
 *
 * Every rejection reason is collected rather than returning on the first, so a
 * near-miss can be explained — "this lesson exists but its planner version
 * changed" is actionable; "no" is not.
 *
 * An https check on the clip URL is deliberate: a provider that returned a
 * relative path or an error string has not produced a reusable asset, and the
 * difference only surfaces when someone tries to play it.
 */
export function evaluateReuse(request: CompatibilityKey, source: SourceLesson): ReuseDecision {
  const reasons: RejectionReason[] = [];
  const mismatches = incompatibilities(request, source.key);
  if (mismatches.length > 0) reasons.push('incompatible');
  if (source.status !== 'succeeded') reasons.push('not-succeeded');
  if (!source.completedAt) reasons.push('not-completed');
  if (!source.planValidated) reasons.push('plan-unvalidated');
  if (source.sceneCount !== source.expectedSceneCount) reasons.push('scene-count');

  for (const scene of source.scenes) {
    if (scene.status !== 'succeeded') { reasons.push('scene-not-succeeded'); break; }
  }
  for (const scene of source.scenes) {
    if (!scene.imageUrl) { reasons.push('missing-image'); break; }
  }
  for (const scene of source.scenes) {
    if (scene.motionMode === 'animate'
      && !(scene.rawVideoUrl && scene.rawVideoUrl.startsWith('https://'))) {
      reasons.push('missing-clip'); break;
    }
  }
  return { reusable: reasons.length === 0, reasons, incompatibilities: mismatches };
}

/** Where a reused asset came from, carried onto the new scene. */
export interface AssetProvenance {
  sourceLessonId: string;
  sourceSceneIndex: number;
  stage: 'image' | 'motion';
  modelVersion: string;
  pipelineVersion: string;
  reusedAt: string;
}

/**
 * The provenance records a reuse produces.
 *
 * Written onto the new scenes so a lesson can always answer "where did this
 * picture come from" — which is what makes a bad asset recallable across every
 * lesson that borrowed it, instead of only the one that made it.
 */
export function provenanceFor(
  source: SourceLesson,
  reusedAt: string,
): AssetProvenance[] {
  const records: AssetProvenance[] = [];
  for (const scene of source.scenes) {
    records.push({
      sourceLessonId: source.lessonId, sourceSceneIndex: scene.sceneIndex, stage: 'image',
      modelVersion: source.key.modelVersions.image ?? 'unknown',
      pipelineVersion: source.key.pipelineVersion, reusedAt,
    });
    if (scene.motionMode === 'animate') {
      records.push({
        sourceLessonId: source.lessonId, sourceSceneIndex: scene.sceneIndex, stage: 'motion',
        modelVersion: source.key.modelVersions.motion ?? 'unknown',
        pipelineVersion: source.key.pipelineVersion, reusedAt,
      });
    }
  }
  return records;
}

export type Stage = 'plan' | 'image' | 'speech' | 'motion' | 'assemble';

/**
 * Which stages a reuse saves, and which still have to run.
 *
 * Assembly always re-runs: the narration is this lesson's, the timeline is
 * this lesson's, and a concatenation is cheap. Speech always re-runs for the
 * same reason — reusing audio would mean reusing the narration text, which is
 * the part a teacher is most likely to have edited.
 */
export function stagePlan(decision: ReuseDecision): Record<Stage, 'reuse' | 'run'> {
  const reuse = decision.reusable;
  return {
    plan: reuse ? 'reuse' : 'run',
    image: reuse ? 'reuse' : 'run',
    motion: reuse ? 'reuse' : 'run',
    speech: 'run',
    assemble: 'run',
  };
}
