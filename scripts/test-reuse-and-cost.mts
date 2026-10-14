/**
 * Reuse compatibility and cost accounting, checked offline.
 *
 * These cover the decisions, not the locking. Atomicity under concurrency is a
 * database property — `reserve_lesson`'s advisory lock — and is asserted in
 * `supabase/tests/reuse_concurrency.sql`, which needs a running Postgres. What
 * runs here is everything that decides WHETHER to reuse and WHAT it cost, so a
 * wrong answer is caught without a database or a GPU.
 *
 *   npm run test:reuse
 */

import {
  type CompatibilityKey,
  type SourceLesson,
  compatibilityKey,
  evaluateReuse,
  incompatibilities,
  isCompatible,
  provenanceFor,
  stagePlan,
} from '../src/lib/generation/reuse.ts';
import {
  type JobUsage,
  checkAnimationCap,
  checkBudget,
  estimateModes,
  gpuCostUsd,
  reconcile,
  summarise,
} from '../src/lib/generation/cost.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const KEY: CompatibilityKey = {
  curriculum: 'NCERT-2023', classLevel: 10, subject: 'Science',
  chapter: 'Light', topic: 'Reflection and Refraction', language: 'en-IN',
  difficulty: 'standard', durationSeconds: 60, visualStyle: 'illustrated',
  contentVersion: 'lesson.v1', pipelineVersion: 'v1',
  modelVersions: { plan: 'qwen3-4b', image: 'z-image-turbo', motion: 'wan-2.2-ti2v-5b' },
};

const scenes = Array.from({ length: 8 }, (_, i) => ({
  sceneIndex: i + 1, status: 'succeeded',
  imageUrl: `https://cdn.test/img-${i + 1}.png`,
  motionMode: (i < 3 ? 'animate' : 'still') as 'animate' | 'still',
  rawVideoUrl: i < 3 ? `https://cdn.test/clip-${i + 1}.mp4` : null,
}));

const SOURCE: SourceLesson = {
  lessonId: 'lesson-a', key: KEY, status: 'succeeded',
  completedAt: '2026-10-14T10:00:00Z', planValidated: true,
  sceneCount: 8, expectedSceneCount: 8, scenes,
};

// ── 1. An exact reusable lesson does not start a new generation ─────────────

const exact = evaluateReuse(KEY, SOURCE);
check(exact.reusable, `an identical lesson must be reusable; got ${exact.reasons.join(', ')}`);
const plan = stagePlan(exact);
check(plan.image === 'reuse' && plan.motion === 'reuse' && plan.plan === 'reuse',
  'a reusable source must save the plan, pictures and motion');
check(plan.speech === 'run' && plan.assemble === 'run',
  'speech and assembly always re-run - the narration and timeline are this lesson\'s');
console.log('reuse: an exact compatible lesson reuses plan, pictures and motion');

// Key order must not change the key, or reuse becomes load-dependent.
const reordered: CompatibilityKey = {
  ...KEY, modelVersions: { motion: 'wan-2.2-ti2v-5b', image: 'z-image-turbo', plan: 'qwen3-4b' },
};
check(compatibilityKey(KEY) === compatibilityKey(reordered),
  'model-version key order must not change the compatibility key');
check(compatibilityKey({ ...KEY, topic: '  reflection AND  Refraction ' }) === compatibilityKey(KEY),
  'case and spacing must not split one topic into two lessons');
console.log('reuse: the key is stable across key order, case and spacing');

// ── 2. Incompatible versions do not reuse old content ──────────────────────

const versionCases: [string, Partial<CompatibilityKey>][] = [
  ['content version', { contentVersion: 'lesson.v2' }],
  ['pipeline version', { pipelineVersion: 'v2' }],
  ['image model', { modelVersions: { ...KEY.modelVersions, image: 'flux-schnell' } }],
  ['motion model', { modelVersions: { ...KEY.modelVersions, motion: 'kling-2.5' } }],
  ['curriculum', { curriculum: 'NCERT-2026' }],
  ['difficulty', { difficulty: 'advanced' }],
  ['chapter', { chapter: 'Human Eye' }],
  ['class', { classLevel: 9 }],
  ['language', { language: 'hi-IN' }],
  ['style', { visualStyle: 'editorial' }],
  ['duration', { durationSeconds: 30 }],
];
for (const [label, patch] of versionCases) {
  const request = { ...KEY, ...patch } as CompatibilityKey;
  check(!isCompatible(request, KEY), `${label} differing must block reuse`);
  const decision = evaluateReuse(request, SOURCE);
  check(!decision.reusable, `${label}: evaluateReuse must refuse`);
  check(decision.incompatibilities.length > 0, `${label}: the mismatch must be named`);
}
console.log(`reuse: ${versionCases.length} version and curriculum dimensions each block reuse`);

// A chapter present on one side only is a mismatch, not a wildcard.
check(!isCompatible({ ...KEY, chapter: null }, KEY), 'a null chapter must not match a named one');
console.log('reuse: a missing chapter does not match a named chapter');

// ── 3. Failed, incomplete or unvalidated sources are never reusable ────────

const badSources: [string, SourceLesson][] = [
  ['failed lesson', { ...SOURCE, status: 'failed' }],
  ['still generating', { ...SOURCE, status: 'generating_videos' }],
  ['no completion time', { ...SOURCE, completedAt: null }],
  ['plan never validated', { ...SOURCE, planValidated: false }],
  ['short scene list', { ...SOURCE, sceneCount: 7 }],
  ['a scene failed', { ...SOURCE, scenes: scenes.map((s, i) => i === 4 ? { ...s, status: 'failed' } : s) }],
  ['a picture missing', { ...SOURCE, scenes: scenes.map((s, i) => i === 2 ? { ...s, imageUrl: null } : s) }],
  ['an animated scene has no clip', { ...SOURCE, scenes: scenes.map((s, i) => i === 0 ? { ...s, rawVideoUrl: null } : s) }],
  ['a clip url is not https', { ...SOURCE, scenes: scenes.map((s, i) => i === 1 ? { ...s, rawVideoUrl: 'generation failed' } : s) }],
];
for (const [label, source] of badSources) {
  const decision = evaluateReuse(KEY, source);
  check(!decision.reusable, `${label} must never be reusable`);
  check(decision.reasons.length > 0, `${label}: a refusal must say why`);
}
console.log(`reuse: ${badSources.length} unvalidated or incomplete sources are all refused`);

// ── 4. Reused assets retain provenance ─────────────────────────────────────

const records = provenanceFor(SOURCE, '2026-10-15T09:00:00Z');
check(records.length === 8 + 3, `expected 8 image + 3 motion records, got ${records.length}`);
check(records.every((r) => r.sourceLessonId === 'lesson-a'), 'every record must name its source lesson');
check(records.every((r) => r.pipelineVersion === 'v1'), 'every record must carry the pipeline version');
const motion = records.filter((r) => r.stage === 'motion');
check(motion.every((r) => r.modelVersion === 'wan-2.2-ti2v-5b'),
  'a reused clip must record the model that actually made it');
check(new Set(records.map((r) => `${r.stage}:${r.sourceSceneIndex}`)).size === records.length,
  'provenance records must be unique per stage and scene');
console.log(`reuse: ${records.length} provenance records carry source, stage and model version`);

// ── 5. Retries do not double-count a paid provider request ────────────────

const retried: JobUsage[] = [
  { jobId: 'j1', stage: 'motion', status: 'failed', attempt: 1, providerId: 'higgsfield',
    modelId: 'kling-2.5', basis: 'measured', costUsd: 0.175, gpuType: null, gpuSeconds: null,
    cpuSeconds: 2, peakMemoryMb: null, providerRequestId: 'req-1' },
  { jobId: 'j1', stage: 'motion', status: 'succeeded', attempt: 2, providerId: 'higgsfield',
    modelId: 'kling-2.5', basis: 'measured', costUsd: 0, gpuType: null, gpuSeconds: null,
    cpuSeconds: 3, peakMemoryMb: null, providerRequestId: 'req-1' },
];
const retriedCost = summarise(retried);
check(retriedCost.paidRequests === 1,
  `one provider request polled twice must count once, got ${retriedCost.paidRequests}`);
check(retriedCost.totalUsd === 0,
  'the resumed attempt must not re-bill a generation that already happened');
check(retriedCost.wastedUsd === 0.175, `the first attempt is waste, got ${retriedCost.wastedUsd}`);
console.log('cost: a resumed provider request counts once; the failed attempt is waste');

// ── 6. Measured, estimated and unpriced never collapse into one another ───

const mixed: JobUsage[] = [
  { jobId: 'p', stage: 'plan', status: 'succeeded', attempt: 1, providerId: 'local-planner',
    modelId: 'qwen3-4b', basis: 'estimated', costUsd: 0.0043, gpuType: 'RTX 6000 Ada',
    gpuSeconds: 20, cpuSeconds: 1, peakMemoryMb: 8192, providerRequestId: null },
  { jobId: 'i', stage: 'image', status: 'succeeded', attempt: 1, providerId: 'local-image',
    modelId: 'z-image-turbo', basis: 'estimated', costUsd: 0.0069, gpuType: 'RTX 6000 Ada',
    gpuSeconds: 32.24, cpuSeconds: 2, peakMemoryMb: 20836, providerRequestId: null },
  { jobId: 'a', stage: 'assemble', status: 'succeeded', attempt: 1, providerId: 'ffmpeg',
    modelId: 'none', basis: 'unpriced', costUsd: null, gpuType: null, gpuSeconds: null,
    cpuSeconds: 48, peakMemoryMb: 1024, providerRequestId: null },
];
const mixedCost = summarise(mixed);
check(mixedCost.measuredUsd === 0, 'nothing here was measured, so the measured total must be 0');
check(mixedCost.estimatedUsd > 0, 'the GPU stages are estimated, not free');
check(mixedCost.unpricedJobs === 1, 'the ffmpeg stage is unpriced, not zero-cost');
check(!mixedCost.fullyMeasured, 'a lesson priced from a chosen hourly rate is not fully measured');
const imageStage = mixedCost.stages.find((st) => st.stage === 'image')!;
check(imageStage.peakMemoryMb === 20836, `peak VRAM must survive the rollup, got ${imageStage.peakMemoryMb}`);
check(mixedCost.totalGpuSeconds > 50, 'GPU seconds must roll up across stages');
console.log('cost: measured, estimated and unpriced stay separate; unpriced is not zero');

// ── 7. Totals reconcile with recorded stage usage ─────────────────────────

const computed = summarise(mixed).totalUsd;
check(reconcile(computed, mixed).agrees, 'an exact total must reconcile');
check(reconcile(computed + 0.01, mixed).agrees === false, 'a cent of drift must be caught');
check(reconcile(computed + 0.00005, mixed).agrees, 'rounding within tolerance must still agree');
const drift = reconcile(0.02, mixed);
check(drift.differenceUsd > 0 && drift.computedUsd === computed,
  'a disagreement must report both figures, not just fail');
console.log(`cost: totals reconcile to ${computed} USD and drift is detected`);

// ── 8. Budgets and caps are enforced before expensive work ────────────────

check(checkBudget(0.05, 0.10).withinBudget, 'an affordable lesson must pass');
check(!checkBudget(0.20, 0.10).withinBudget, 'an unaffordable lesson must be refused');
check(!checkBudget(0.05, 0).withinBudget, 'no budget configured must refuse, not allow');
check(!checkBudget(0.05, 0.10, 0.08).withinBudget,
  'a resumed lesson must count what it already spent');
check(checkBudget(0.20, 0.10).reason !== null, 'a refusal must explain itself');
console.log('cost: budgets refuse before work starts, and count prior spend');

check(checkAnimationCap(3, 3).withinCap, 'a plan at the cap must pass');
check(!checkAnimationCap(8, 3).withinCap, 'animating every scene must be refused');
check(checkAnimationCap(8, 3).reason?.includes('3'), 'the refusal must name the cap');
console.log('cost: animation caps refuse an over-budget plan before any clip is submitted');

// ── Mode comparison ───────────────────────────────────────────────────────

const modes = estimateModes(0.77);
check(modes.length === 4, 'four generation modes must be summarised');
const byMode = Object.fromEntries(modes.map((m) => [m.mode, m]));
check(byMode.deterministic!.usdPerLesson < byMode.illustrated!.usdPerLesson,
  'deterministic must be the cheapest mode');
check(byMode.illustrated!.usdPerLesson < byMode.editorial!.usdPerLesson,
  'editorial animates the most scenes, so it must cost the most');
check(byMode.deterministic!.animatedScenes === 0, 'the deterministic mode animates nothing');
check(byMode.deterministic!.lessonsPerGpuHour > byMode.editorial!.lessonsPerGpuHour,
  'cheaper modes must yield more lessons per GPU-hour');
check(gpuCostUsd(3600, 0.77) === 0.77, 'an hour of GPU at 0.77/hr must cost 0.77');
for (const m of modes) {
  console.log(`  ${m.mode.padEnd(14)} ${String(m.pictures).padStart(2)} pics  ${m.animatedScenes} animated  ${String(m.gpuSeconds).padStart(6)}s  $${m.usdPerLesson.toFixed(4)}  ${m.lessonsPerGpuHour.toFixed(1)}/GPU-hr`);
}
console.log('cost: mode summaries ordered correctly by expense');

console.log('\nOK');
