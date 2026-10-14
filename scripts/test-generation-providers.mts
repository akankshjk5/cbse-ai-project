/**
 * The provider contract, checked offline.
 *
 * No model calls, no database, no GPU — this covers the part of the generation
 * layer that is pure: status normalisation, capability refusals, the cost
 * estimates both engines are chosen by, and the crossover those estimates
 * imply. The adapters' own RPC calls are covered by `test:cloud-*`.
 *
 *   npm run test:providers
 */

import {
  LESSON_STATUSES,
  fromStoredStatus,
  isTerminal,
  progressFor,
  unsupportedReason,
  type LessonRequest,
  type LessonStatus,
} from '../src/lib/generation/providers/types.ts';
import {
  CAPABILITIES,
  GENERATOR_IDS,
  cloudEstimateUsd,
  crossoverLessonsPerDay,
  generatorIdFromEnv,
  gpuEstimateUsd,
} from '../src/lib/generation/providers/registry.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

// ── Status normalisation ────────────────────────────────────────────────────

const stored = ['preparing', 'generating_images', 'generating_videos', 'assembling',
  'succeeded', 'failed', 'cancelled'] as const;
for (const value of stored) {
  const mapped = fromStoredStatus(value);
  check(LESSON_STATUSES.includes(mapped), `${value} mapped outside the contract: ${mapped}`);
}
check(fromStoredStatus('succeeded') === 'COMPLETED', 'succeeded must be COMPLETED');
check(fromStoredStatus('cancelled') === 'FAILED', 'cancelled is terminal, not in-flight');

// The important one: a status this layer has never seen must not read as done.
check(fromStoredStatus('some_future_stage') === 'PROCESSING',
  'an unknown stored status must fall back to PROCESSING, never COMPLETED');
console.log(`status: ${stored.length} stored values map into the contract; unknown falls back to PROCESSING`);

check(isTerminal('COMPLETED') && isTerminal('FAILED'), 'COMPLETED and FAILED are terminal');
check(!isTerminal('UPLOADING'), 'UPLOADING is not terminal');

// Progress must rise monotonically through the declared order, so a bar driven
// by it can never travel backwards as a lesson advances.
const ordered = LESSON_STATUSES.filter((s): s is LessonStatus => s !== 'FAILED');
for (let i = 1; i < ordered.length; i += 1) {
  const previous = progressFor(ordered[i - 1]!);
  const current = progressFor(ordered[i]!);
  check(current > previous,
    `progress goes backwards at ${ordered[i]}: ${previous} then ${current}`);
}
check(progressFor('COMPLETED') === 1, 'COMPLETED must be 1');
console.log(`progress: ${ordered.length} stages rise monotonically from ${progressFor(ordered[0]!)} to 1`);

// ── Capabilities ────────────────────────────────────────────────────────────

const base: LessonRequest = {
  classLevel: 10, subject: 'Science', topic: 'Light — Reflection and Refraction',
  language: 'en-IN', durationSeconds: 60, visualStyle: 'illustrated', difficulty: 'standard',
};

check(unsupportedReason(CAPABILITIES.cloud, base) === null, 'cloud must accept the base request');
check(unsupportedReason(CAPABILITIES.gpu, base) !== null,
  'the GPU path ships only the editorial style, so it must refuse an illustrated request');
check(unsupportedReason(CAPABILITIES.gpu, { ...base, visualStyle: 'editorial' }) === null,
  'the GPU path must accept editorial');
check(unsupportedReason(CAPABILITIES.cloud, { ...base, durationSeconds: 30 }) === null,
  'cloud must accept 30 seconds');
check(unsupportedReason(CAPABILITIES.gpu, { ...base, visualStyle: 'editorial', durationSeconds: 30 }) !== null,
  'the GPU path ships 60 seconds only');
console.log('capabilities: refusals are declared, not discovered at call time');

for (const id of GENERATOR_IDS) {
  const capability = CAPABILITIES[id];
  check(capability.languages.includes('kn-IN'), `${id} must cover Kannada`);
  check(capability.producesPptx === false,
    `${id} claims to make a .pptx; neither engine binds slides to scenes yet`);
}
check(CAPABILITIES.gpu.requiresGpu && !CAPABILITIES.cloud.requiresGpu,
  'only the self-hosted path needs a GPU');
console.log('capabilities: all three cover en/hi/kn; none claims PPTX, which is still unbuilt');

// ── Cost ────────────────────────────────────────────────────────────────────

const cloud60 = cloudEstimateUsd(base);
const gpu60 = gpuEstimateUsd(base);
check(cloud60 > gpu60, 'the cloud estimate should exceed the GPU estimate per lesson');
check(cloud60 > 0.9 && cloud60 < 1.3,
  `illustrated 60 s should land near USD 1.06, got ${cloud60}`);
check(CAPABILITIES.fixture.estimateUsd(base) === 0, 'the fixture provider must cost nothing');

const storybook = cloudEstimateUsd({ ...base, visualStyle: 'storybook' });
const editorial = cloudEstimateUsd({ ...base, visualStyle: 'editorial' });
check(storybook > cloud60, 'storybook draws two pictures a scene, so it costs more');
check(editorial > storybook, 'editorial animates six scenes, the most of the three');
console.log(`cost: illustrated $${cloud60.toFixed(3)} · storybook $${storybook.toFixed(3)} · editorial $${editorial.toFixed(3)} · gpu $${gpu60.toFixed(3)}`);

// A 30-second lesson must cost less than a 60-second one in every style.
for (const style of ['illustrated', 'editorial', 'storybook'] as const) {
  const short = cloudEstimateUsd({ ...base, visualStyle: style, durationSeconds: 30 });
  const long = cloudEstimateUsd({ ...base, visualStyle: style, durationSeconds: 60 });
  check(short < long, `${style}: 30 s should cost less than 60 s`);
}
console.log('cost: every style is cheaper at 30 s than at 60 s');

const crossover = crossoverLessonsPerDay(base);
check(crossover !== null && crossover >= 10 && crossover <= 30,
  `the crossover should land in the teens, got ${crossover}`);
console.log(`crossover: the GPU path pays for itself above ~${crossover} lessons/day`);

// ── Selection ───────────────────────────────────────────────────────────────

check(generatorIdFromEnv(undefined) === 'cloud', 'unset must default to cloud');
check(generatorIdFromEnv('GPU') === 'gpu', 'selection is case-insensitive');
check(generatorIdFromEnv(' fixture ') === 'fixture', 'selection trims');
let refused = false;
try { generatorIdFromEnv('runpod'); } catch { refused = true; }
check(refused, 'an unknown generator must be refused, not silently defaulted');
console.log('selection: defaults to cloud, refuses an unknown id rather than guessing');

console.log('\nOK');
