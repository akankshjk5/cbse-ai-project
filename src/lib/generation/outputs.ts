/**
 * Which of a teacher's requested outputs an existing lesson can satisfy.
 *
 * `evaluateReuse` already answers "may this source be reused at all", and
 * `stagePlan` answers "which stages does that save". Neither can express the
 * cases that matter most for a shared library:
 *
 *   - A teacher who wants only a deck should not cause a video to be rendered.
 *   - A teacher who has a video and needs a deck should get the deck built from
 *     the stored plan, without redrawing a single picture.
 *   - A teacher who wants the Kannada version of an English lesson should reuse
 *     every picture and clip, and pay only for narration and assembly.
 *
 * The third case is why `reuse` and `generate` are not enough. The visuals are
 * compatible and the video is not: the file has English audio burned into it.
 * Calling that a miss re-draws four pictures for no reason, and calling it a
 * hit hands a child the wrong language. So there is a third disposition,
 * `rebuild`, which means "assemble a new file out of parts already paid for".
 */

import {
  type CompatibilityKey,
  type Incompatibility,
  type ReuseDecision,
  type SourceLesson,
  type Stage,
  evaluateReuse,
  incompatibilities,
} from './reuse';

export const OUTPUT_KINDS = ['video', 'pptx'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/**
 * What has to happen for one requested output.
 *
 * `reuse`   — an existing validated asset is served unchanged. No work.
 * `rebuild` — the expensive parts are reused, the output is assembled again.
 * `generate`— nothing compatible exists; the full pipeline runs.
 */
export type Disposition = 'reuse' | 'rebuild' | 'generate';

export interface OutputPlan {
  kind: OutputKind;
  disposition: Disposition;
  /** Stages that must run for this output specifically. */
  stages: Stage[];
  reason: string;
}

/**
 * Bumped when the rules below change.
 *
 * Recorded on every reuse event, so a decision made last term can be explained
 * by the rules in force when it was made rather than by today's.
 */
export const DECISION_VERSION = 'outputs/1.0.0';

/**
 * Dimensions that describe the narration rather than the pictures.
 *
 * A difference in one of these makes the audio wrong while leaving every
 * keyframe and clip perfectly good — which is exactly the case `rebuild`
 * exists for. Everything else in the key describes what is drawn, and a
 * difference there means the visuals cannot be trusted.
 */
const LANGUAGE_DIMENSIONS: readonly Incompatibility[] = ['language'];

function isLanguageOnly(mismatches: readonly Incompatibility[]): boolean {
  return mismatches.length > 0
    && mismatches.every((m) => LANGUAGE_DIMENSIONS.includes(m));
}

export interface OutputRequest {
  key: CompatibilityKey;
  /** What the teacher asked for. At least one, no duplicates. */
  outputs: readonly OutputKind[];
}

export interface SourceOutputs {
  lesson: SourceLesson;
  /** Outputs the source actually has as validated assets. */
  available: readonly OutputKind[];
}

export interface ReusePlan {
  decision: 'full' | 'partial' | 'language_variant' | 'miss';
  outputs: OutputPlan[];
  /** Union of stages across all requested outputs, for the job record. */
  stages: Stage[];
  /** Mismatches that stopped a straight reuse, for the audit rationale. */
  incompatibilities: Incompatibility[];
  decisionVersion: string;
}

const FULL_PIPELINE: Stage[] = ['plan', 'image', 'motion', 'speech', 'assemble'];
/** A deck needs the plan and the pictures; it has no audio and no motion. */
const PPTX_STAGES: Stage[] = ['plan', 'image'];
/** A language variant keeps the pictures and pays for the voice. */
const REBUILD_VIDEO_STAGES: Stage[] = ['speech', 'assemble'];

/**
 * The plan for one request against one candidate source.
 *
 * Deterministic: the same request and source always produce the same plan, and
 * the rules that produced it are named by `decisionVersion`. Nothing here is
 * scored or thresholded — a dimension matches or it does not.
 */
export function planOutputs(request: OutputRequest, source: SourceOutputs | null): ReusePlan {
  const requested = dedupe(request.outputs);
  if (requested.length === 0) {
    throw new Error('A request must name at least one output');
  }

  if (!source) {
    return {
      decision: 'miss',
      outputs: requested.map((kind) => ({
        kind,
        disposition: 'generate',
        stages: kind === 'pptx' ? PPTX_STAGES : FULL_PIPELINE,
        reason: 'no candidate lesson',
      })),
      stages: unionStages(requested.map((k) => (k === 'pptx' ? PPTX_STAGES : FULL_PIPELINE))),
      incompatibilities: [],
      decisionVersion: DECISION_VERSION,
    };
  }

  const mismatches = incompatibilities(request.key, source.lesson.key);
  const languageOnly = isLanguageOnly(mismatches);

  // Ask the existing evaluator about everything that is not the language. A
  // language-only difference is handled here rather than there, because
  // `evaluateReuse` is right to call it incompatible — the finished file is.
  const visualKey: CompatibilityKey = languageOnly
    ? { ...source.lesson.key, language: request.key.language }
    : request.key;
  const assetCheck: ReuseDecision = evaluateReuse(visualKey, {
    ...source.lesson,
    key: { ...source.lesson.key, language: request.key.language },
  });

  // Assets unusable for any reason other than the language: the source is
  // incomplete or stale, so nothing about it can be trusted.
  const visualsUsable = assetCheck.reasons.every((r) => r !== 'incompatible')
    && assetCheck.reasons.length === 0;

  const outputs: OutputPlan[] = requested.map((kind) => {
    if (!visualsUsable) {
      return {
        kind,
        disposition: 'generate',
        stages: kind === 'pptx' ? PPTX_STAGES : FULL_PIPELINE,
        reason: assetCheck.reasons.length
          ? `source unusable: ${assetCheck.reasons.join(', ')}`
          : `incompatible: ${mismatches.join(', ')}`,
      };
    }
    if (mismatches.length > 0 && !languageOnly) {
      return {
        kind,
        disposition: 'generate',
        stages: kind === 'pptx' ? PPTX_STAGES : FULL_PIPELINE,
        reason: `incompatible: ${mismatches.join(', ')}`,
      };
    }
    // A deck carries no audio, so a language difference does not spoil one that
    // was built in the requested language; one built in another language has to
    // be laid out again from the same plan and pictures.
    if (kind === 'pptx') {
      if (source.available.includes('pptx') && !languageOnly) {
        return { kind, disposition: 'reuse', stages: [], reason: 'validated deck exists' };
      }
      return {
        kind,
        disposition: 'rebuild',
        stages: ['assemble'],
        reason: source.available.includes('pptx')
          ? 'deck exists in another language; relaid from the same plan'
          : 'no deck yet; built from the stored plan and pictures',
      };
    }
    if (languageOnly) {
      return {
        kind,
        disposition: 'rebuild',
        stages: REBUILD_VIDEO_STAGES,
        reason: `visuals reused; ${request.key.language} narration and assembly run`,
      };
    }
    if (source.available.includes('video')) {
      return { kind, disposition: 'reuse', stages: [], reason: 'validated video exists' };
    }
    return {
      kind,
      disposition: 'rebuild',
      stages: REBUILD_VIDEO_STAGES,
      reason: 'visuals exist but no finished video; narration and assembly run',
    };
  });

  return {
    decision: classify(outputs, languageOnly),
    outputs,
    stages: unionStages(outputs.map((o) => o.stages)),
    incompatibilities: mismatches,
    decisionVersion: DECISION_VERSION,
  };
}

function classify(outputs: readonly OutputPlan[], languageOnly: boolean): ReusePlan['decision'] {
  if (outputs.every((o) => o.disposition === 'generate')) return 'miss';
  if (languageOnly) return 'language_variant';
  if (outputs.every((o) => o.disposition === 'reuse')) return 'full';
  return 'partial';
}

function dedupe(kinds: readonly OutputKind[]): OutputKind[] {
  return OUTPUT_KINDS.filter((k) => kinds.includes(k));
}

function unionStages(lists: readonly (readonly Stage[])[]): Stage[] {
  const order: Stage[] = ['plan', 'image', 'motion', 'speech', 'assemble'];
  const seen = new Set<Stage>();
  for (const list of lists) for (const stage of list) seen.add(stage);
  return order.filter((s) => seen.has(s));
}

// ── Savings ─────────────────────────────────────────────────────────────────

export type SavingsBasis = 'measured' | 'estimated' | 'unknown';

export interface Savings {
  usd: number | null;
  basis: SavingsBasis;
  gpuSeconds: number | null;
  /** Stages that did not run because something was reused. */
  avoidedStages: Stage[];
}

export interface SourceCost {
  /** What the source lesson actually cost, per stage, if it was measured. */
  perStageUsd: Partial<Record<Stage, number>>;
  perStageGpuSeconds: Partial<Record<Stage, number>>;
  /** Whether those figures came from a bill or a rate card. */
  basis: SavingsBasis;
}

/**
 * What a reuse avoided, and how firmly that is known.
 *
 * A saving is only as trustworthy as the cost it is derived from. If the
 * source's own cost was estimated, the saving is an estimate; if the source
 * never recorded one, the saving is `unknown` with a null figure rather than
 * zero. Reporting an unpriced saving as ₹0 understates the system's value, and
 * reporting it as a number nobody measured overstates it — the column exists so
 * neither happens silently.
 */
export function savingsFor(plan: ReusePlan, cost: SourceCost | null): Savings {
  const ran = new Set(plan.stages);
  const avoidedStages = FULL_PIPELINE.filter((stage) => !ran.has(stage));

  if (avoidedStages.length === 0) {
    // Nothing was skipped, so nothing was saved. That is a measured zero.
    return { usd: 0, basis: 'measured', gpuSeconds: 0, avoidedStages: [] };
  }
  if (!cost || cost.basis === 'unknown') {
    return { usd: null, basis: 'unknown', gpuSeconds: null, avoidedStages };
  }

  let usd = 0;
  let gpuSeconds = 0;
  let sawFigure = false;
  for (const stage of avoidedStages) {
    const stageUsd = cost.perStageUsd[stage];
    const stageGpu = cost.perStageGpuSeconds[stage];
    if (stageUsd !== undefined) { usd += stageUsd; sawFigure = true; }
    if (stageGpu !== undefined) { gpuSeconds += stageGpu; sawFigure = true; }
  }
  if (!sawFigure) {
    // The source has a basis but no figure for any avoided stage: priced for
    // stages that ran, unpriced for the ones that did not.
    return { usd: null, basis: 'unknown', gpuSeconds: null, avoidedStages };
  }
  return {
    usd: round6(usd),
    basis: cost.basis,
    gpuSeconds: gpuSeconds > 0 ? round3(gpuSeconds) : null,
    avoidedStages,
  };
}

function round6(value: number): number { return Math.round(value * 1e6) / 1e6; }
function round3(value: number): number { return Math.round(value * 1e3) / 1e3; }

// ── Audit ───────────────────────────────────────────────────────────────────

export interface ReuseEvent {
  requestedBy: string;
  projectId: string;
  sourceProjectId: string | null;
  schoolId: string | null;
  decision: ReusePlan['decision'];
  satisfiedOutputs: OutputKind[];
  generatedOutputs: OutputKind[];
  reusedAssetIds: string[];
  savingsUsd: number | null;
  savingsBasis: SavingsBasis;
  savingsGpuSeconds: number | null;
  rationale: string;
}

/**
 * The row to write after serving a request.
 *
 * `rationale` is written for a person reading an audit months later, so it
 * names the decision version and what each output did — not a status code they
 * would have to look up.
 */
export function reuseEvent(args: {
  requestedBy: string;
  projectId: string;
  sourceProjectId: string | null;
  schoolId: string | null;
  plan: ReusePlan;
  savings: Savings;
  reusedAssetIds: readonly string[];
}): ReuseEvent {
  const { plan, savings } = args;
  // Disjoint on purpose. A `rebuild` is partly reuse and partly work, and
  // putting it in both lists makes "how many outputs were served for free"
  // unanswerable. Satisfied means served with no new work at all; everything
  // that cost something counts as generated, and `savings_usd` carries how
  // much the reused parts were worth.
  const satisfied = plan.outputs.filter((o) => o.disposition === 'reuse').map((o) => o.kind);
  const generated = plan.outputs.filter((o) => o.disposition !== 'reuse').map((o) => o.kind);
  const detail = plan.outputs.map((o) => `${o.kind}: ${o.disposition} (${o.reason})`).join('; ');
  return {
    requestedBy: args.requestedBy,
    projectId: args.projectId,
    sourceProjectId: args.sourceProjectId,
    schoolId: args.schoolId,
    decision: plan.decision,
    satisfiedOutputs: satisfied,
    generatedOutputs: generated,
    reusedAssetIds: [...args.reusedAssetIds],
    savingsUsd: savings.usd,
    savingsBasis: savings.basis,
    savingsGpuSeconds: savings.gpuSeconds,
    rationale: `${plan.decisionVersion} — ${detail}`.slice(0, 600),
  };
}
