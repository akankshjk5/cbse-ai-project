/**
 * Which outputs a request reuses, which it rebuilds, and what that saved.
 *
 * These run entirely in memory — no database, no network. The schema-level
 * guarantees they cannot cover (unique constraints, RLS, concurrent claims)
 * are tested against a real PostgreSQL in supabase/tests/shared_asset_reuse.sql.
 *
 *   npm run test:outputs
 */

import {
  DECISION_VERSION,
  type OutputKind,
  type SourceCost,
  planOutputs,
  reuseEvent,
  savingsFor,
} from '../src/lib/generation/outputs.ts';
import type { CompatibilityKey, SourceLesson } from '../src/lib/generation/reuse.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const KEY: CompatibilityKey = {
  curriculum: 'KTBS',
  classLevel: 10,
  subject: 'Science',
  chapter: 'Carbon and its Compounds',
  topic: 'Covalent bonding in carbon',
  language: 'en-IN',
  difficulty: 'standard',
  durationSeconds: 30,
  visualStyle: 'illustrated',
  contentVersion: '1.0.0',
  pipelineVersion: 'v1',
  modelVersions: { image: 'z-image-turbo@bf16', motion: 'wan-2.2-ti2v-5b@fp16' },
};

function source(over: Partial<SourceLesson> = {}): SourceLesson {
  return {
    lessonId: 'src-1',
    key: KEY,
    status: 'succeeded',
    completedAt: '2026-10-01T00:00:00.000Z',
    planValidated: true,
    sceneCount: 4,
    expectedSceneCount: 4,
    scenes: [1, 2, 3, 4].map((i) => ({
      sceneIndex: i,
      status: 'succeeded',
      imageUrl: `https://store/k${i}.png`,
      motionMode: i <= 2 ? 'animate' as const : 'still' as const,
      rawVideoUrl: i <= 2 ? `https://store/c${i}.webm` : null,
    })),
    ...over,
  };
}

const COST: SourceCost = {
  perStageUsd: { plan: 0.004, image: 0.012, motion: 0.031, speech: 0.009, assemble: 0 },
  perStageGpuSeconds: { plan: 20, image: 16.1, motion: 96.3, speech: 45, assemble: 0 },
  basis: 'measured',
};

const by = (plan: ReturnType<typeof planOutputs>, kind: OutputKind) =>
  plan.outputs.find((o) => o.kind === kind)!;

// ── Video-only request must not build a deck ───────────────────────────────

let plan = planOutputs({ key: KEY, outputs: ['video'] },
  { lesson: source(), available: ['video'] });
check(plan.decision === 'full', `expected full, got ${plan.decision}`);
check(plan.outputs.length === 1, 'a video-only request plans one output');
check(by(plan, 'video').disposition === 'reuse', 'the existing video is served');
check(plan.stages.length === 0, `nothing should run, got ${plan.stages.join(',')}`);
console.log('video-only: reuses the video and plans no deck at all');

// Even when a deck exists, an unrequested output is never produced.
plan = planOutputs({ key: KEY, outputs: ['video'] },
  { lesson: source(), available: ['video', 'pptx'] });
check(plan.outputs.every((o) => o.kind !== 'pptx'), 'an unrequested deck must not appear in the plan');
console.log('video-only: an available deck is still not planned, because it was not asked for');

// ── Deck-only request reuses a compatible deck ─────────────────────────────

plan = planOutputs({ key: KEY, outputs: ['pptx'] },
  { lesson: source(), available: ['video', 'pptx'] });
check(by(plan, 'pptx').disposition === 'reuse', 'a compatible deck is reused');
check(plan.stages.length === 0, 'reusing a deck runs nothing');
console.log('pptx-only: an existing compatible deck is served unchanged');

// ── Partial: video exists, deck does not ───────────────────────────────────

plan = planOutputs({ key: KEY, outputs: ['video', 'pptx'] },
  { lesson: source(), available: ['video'] });
check(plan.decision === 'partial', `expected partial, got ${plan.decision}`);
check(by(plan, 'video').disposition === 'reuse', 'the video is reused');
check(by(plan, 'pptx').disposition === 'rebuild', 'the missing deck is built');
check(!plan.stages.includes('image'), 'building a deck must not redraw pictures');
check(!plan.stages.includes('motion'), 'building a deck must not re-run motion');
console.log('partial: the deck is built from the stored plan; no picture is redrawn');

// ── Language variant: visuals reused, voice paid for ───────────────────────

const kannada: CompatibilityKey = { ...KEY, language: 'kn-IN' };
plan = planOutputs({ key: kannada, outputs: ['video'] },
  { lesson: source(), available: ['video'] });
check(plan.decision === 'language_variant', `expected language_variant, got ${plan.decision}`);
check(by(plan, 'video').disposition === 'rebuild', 'the English file cannot be served as Kannada');
check(plan.stages.includes('speech'), 'Kannada narration must be generated');
check(plan.stages.includes('assemble'), 'the video must be assembled again');
check(!plan.stages.includes('image'), 'but no picture is redrawn');
check(!plan.stages.includes('motion'), 'and no clip is re-rendered');
console.log('language: Kannada reuses every picture and clip, paying only for voice and assembly');

// ── A material difference must not hit the cache ───────────────────────────

for (const [label, changed] of [
  ['a different chapter', { ...KEY, chapter: 'Life Processes' }],
  ['a newer textbook edition', { ...KEY, contentVersion: '2.0.0' }],
  ['a different visual style', { ...KEY, visualStyle: 'storybook' }],
  ['a swapped image model', { ...KEY, modelVersions: { ...KEY.modelVersions, image: 'z-image@v2' } }],
] as const) {
  const miss = planOutputs({ key: changed, outputs: ['video'] },
    { lesson: source(), available: ['video'] });
  check(miss.decision === 'miss', `${label} must not hit the cache, got ${miss.decision}`);
  check(by(miss, 'video').disposition === 'generate', `${label} must regenerate`);
}
console.log('safety: chapter, edition, style and model changes each force a full generation');

// ── An incomplete source is not reusable at all ────────────────────────────

const noClip = source({
  scenes: source().scenes.map((s) => (s.sceneIndex === 1 ? { ...s, rawVideoUrl: null } : s)),
});
plan = planOutputs({ key: KEY, outputs: ['video'] }, { lesson: noClip, available: ['video'] });
check(plan.decision === 'miss', 'a source missing an animated scene clip is not reusable');
check(by(plan, 'video').reason.includes('missing-clip'), `reason should name it: ${by(plan, 'video').reason}`);

const unfinished = source({ status: 'failed', completedAt: null });
plan = planOutputs({ key: KEY, outputs: ['video'] }, { lesson: unfinished, available: [] });
check(plan.decision === 'miss', 'a failed lesson is never a source');
console.log('integrity: an incomplete or failed source is refused, and the reason is named');

// ── No candidate at all ────────────────────────────────────────────────────

plan = planOutputs({ key: KEY, outputs: ['video', 'pptx'] }, null);
check(plan.decision === 'miss', 'no candidate is a miss');
check(plan.outputs.every((o) => o.disposition === 'generate'), 'everything generates');
console.log('miss: with no candidate, both outputs are generated');

// ── Savings, and how firmly they are known ─────────────────────────────────

const full = planOutputs({ key: KEY, outputs: ['video'] },
  { lesson: source(), available: ['video'] });
let savings = savingsFor(full, COST);
check(savings.basis === 'measured', 'a measured source yields a measured saving');
check(savings.usd !== null && Math.abs(savings.usd - 0.056) < 1e-9,
  `full reuse saves every stage: expected 0.056, got ${savings.usd}`);
check(savings.avoidedStages.length === 5, 'a full reuse avoids all five stages');

const variant = planOutputs({ key: kannada, outputs: ['video'] },
  { lesson: source(), available: ['video'] });
savings = savingsFor(variant, COST);
check(savings.usd !== null && Math.abs(savings.usd - 0.047) < 1e-9,
  `a language variant saves plan+image+motion: expected 0.047, got ${savings.usd}`);
check(savings.avoidedStages.includes('image') && savings.avoidedStages.includes('motion'),
  'the avoided stages are the expensive ones');
check(!savings.avoidedStages.includes('speech'), 'speech was paid for, so it is not a saving');
console.log(`savings: full reuse $${0.056}, language variant $${0.047}, both measured`);

savings = savingsFor(full, null);
check(savings.basis === 'unknown' && savings.usd === null,
  'a source with no recorded cost yields an unknown saving, never zero');
savings = savingsFor(full, { ...COST, basis: 'estimated' });
check(savings.basis === 'estimated', 'an estimated source cost yields an estimated saving');
savings = savingsFor(full, { perStageUsd: {}, perStageGpuSeconds: {}, basis: 'measured' });
check(savings.basis === 'unknown' && savings.usd === null,
  'a basis with no figure for any avoided stage is unknown, not zero');

const miss = planOutputs({ key: { ...KEY, chapter: 'Other' }, outputs: ['video'] },
  { lesson: source(), available: ['video'] });
savings = savingsFor(miss, COST);
check(savings.usd === 0 && savings.basis === 'measured',
  'a full generation saved nothing, and that zero is measured');
console.log('savings: unpriced stays unpriced; an unknown cost never becomes a free lesson');

// ── The audit row ──────────────────────────────────────────────────────────

const event = reuseEvent({
  requestedBy: 'user_teacher_b',
  projectId: 'proj-new',
  sourceProjectId: 'proj-src',
  schoolId: 'school-1',
  plan: planOutputs({ key: KEY, outputs: ['video', 'pptx'] },
    { lesson: source(), available: ['video'] }),
  savings: savingsFor(planOutputs({ key: KEY, outputs: ['video', 'pptx'] },
    { lesson: source(), available: ['video'] }), COST),
  reusedAssetIds: ['asset-a', 'asset-b'],
});
check(event.decision === 'partial', 'the event records the decision');
check(event.satisfiedOutputs.includes('video'), 'video was satisfied by reuse');
check(event.generatedOutputs.includes('pptx'), 'the deck was generated');
check(!event.satisfiedOutputs.includes('pptx'), 'a rebuilt deck is not a satisfied reuse');
check(event.rationale.startsWith(DECISION_VERSION),
  `the rationale names the rule version: ${event.rationale.slice(0, 40)}`);
check(event.rationale.length <= 600, 'the rationale fits the column');
check(!JSON.stringify(event).includes('owner'), 'the event carries no owner identity');
console.log('audit: the event names the decision, the version, and no source teacher');

console.log('\nOK');
