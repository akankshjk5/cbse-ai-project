/**
 * What a lesson cost, by job and by stage, and how much of that figure is
 * actually known.
 *
 * The distinction this module exists to keep is between a cost that was
 * **measured** and one that was **estimated**. A paid provider reports tokens,
 * so its bill is measured. Our own GPU reports seconds, so its cost is an
 * hourly rate multiplied by runtime — defensible, but a rate we chose, and it
 * moves. A stage with no usage data at all is **unpriced**, which is not the
 * same as free: reporting an unknown as zero makes a lesson look cheaper than
 * it was, and that error compounds across every report built on it.
 *
 * So `LessonCost` never collapses to one number. It carries the measured
 * total, the estimated total and the unpriced stage count separately, and a
 * caller that wants a single figure has to decide what to do about the parts
 * that are not known.
 *
 * Wasted compute is counted too. A job that failed twice before succeeding
 * spent GPU time three times, and a cost model that only counts the successful
 * attempt will under-predict a fleet by exactly the failure rate.
 */

export type CostBasis = 'measured' | 'estimated' | 'unpriced';
export type CostStage = 'plan' | 'image' | 'speech' | 'motion' | 'assemble';

export const COST_STAGES: readonly CostStage[] = ['plan', 'image', 'speech', 'motion', 'assemble'];

/** One attempt at one job, as the worker recorded it. */
export interface JobUsage {
  jobId: string;
  stage: CostStage;
  /** `succeeded` contributes to the lesson; anything else is waste. */
  status: 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  providerId: string;
  modelId: string;
  basis: CostBasis;
  /** Null when unpriced. Zero is a real zero — our own hardware, no API bill. */
  costUsd: number | null;
  gpuType: string | null;
  gpuSeconds: number | null;
  cpuSeconds: number | null;
  peakMemoryMb: number | null;
  /** Set when a paid provider assigned one, for deduplicating a retry. */
  providerRequestId: string | null;
}

export interface StageCost {
  stage: CostStage;
  attempts: number;
  succeeded: number;
  measuredUsd: number;
  estimatedUsd: number;
  unpricedJobs: number;
  wastedUsd: number;
  gpuSeconds: number;
  cpuSeconds: number;
  peakMemoryMb: number | null;
}

export interface LessonCost {
  stages: StageCost[];
  measuredUsd: number;
  estimatedUsd: number;
  /** measured + estimated. Excludes unpriced, which is why the count matters. */
  totalUsd: number;
  unpricedJobs: number;
  wastedUsd: number;
  totalGpuSeconds: number;
  totalCpuSeconds: number;
  /** True when every priced job was measured — the only case a total is exact. */
  fullyMeasured: boolean;
  /** Distinct paid provider requests, so a retry cannot double-count one. */
  paidRequests: number;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Roll a lesson's job rows into a cost.
 *
 * A paid provider request is counted once however many attempts referenced it:
 * a worker that resumes a job after a lease expires polls the *same*
 * `providerRequestId` rather than submitting again, so counting attempts would
 * bill a lesson for generations that never happened.
 */
export function summarise(jobs: readonly JobUsage[]): LessonCost {
  const stages: StageCost[] = COST_STAGES.map((stage) => {
    const rows = jobs.filter((job) => job.stage === stage);
    const memories = rows.map((r) => r.peakMemoryMb).filter((v): v is number => v !== null);
    return {
      stage,
      attempts: rows.length,
      succeeded: rows.filter((r) => r.status === 'succeeded').length,
      measuredUsd: round(rows.filter((r) => r.basis === 'measured' && r.status === 'succeeded')
        .reduce((sum, r) => sum + (r.costUsd ?? 0), 0)),
      estimatedUsd: round(rows.filter((r) => r.basis === 'estimated' && r.status === 'succeeded')
        .reduce((sum, r) => sum + (r.costUsd ?? 0), 0)),
      unpricedJobs: rows.filter((r) => r.basis === 'unpriced').length,
      wastedUsd: round(rows.filter((r) => r.status !== 'succeeded')
        .reduce((sum, r) => sum + (r.costUsd ?? 0), 0)),
      gpuSeconds: round(rows.reduce((sum, r) => sum + (r.gpuSeconds ?? 0), 0)),
      cpuSeconds: round(rows.reduce((sum, r) => sum + (r.cpuSeconds ?? 0), 0)),
      peakMemoryMb: memories.length ? Math.max(...memories) : null,
    };
  });

  const measuredUsd = round(stages.reduce((sum, s) => sum + s.measuredUsd, 0));
  const estimatedUsd = round(stages.reduce((sum, s) => sum + s.estimatedUsd, 0));
  const priced = jobs.filter((job) => job.basis !== 'unpriced');
  const paidRequests = new Set(
    jobs.map((job) => job.providerRequestId).filter((id): id is string => !!id),
  ).size;

  return {
    stages,
    measuredUsd,
    estimatedUsd,
    totalUsd: round(measuredUsd + estimatedUsd),
    unpricedJobs: stages.reduce((sum, s) => sum + s.unpricedJobs, 0),
    wastedUsd: round(stages.reduce((sum, s) => sum + s.wastedUsd, 0)),
    totalGpuSeconds: round(stages.reduce((sum, s) => sum + s.gpuSeconds, 0)),
    totalCpuSeconds: round(stages.reduce((sum, s) => sum + s.cpuSeconds, 0)),
    fullyMeasured: priced.length > 0 && priced.every((job) => job.basis === 'measured'),
    paidRequests,
  };
}

/**
 * Cost of our own GPU time, from an hourly rate.
 *
 * Always `estimated`: the rate is a commercial decision, not something the job
 * reported. The seconds are measured; the money is not.
 */
export function gpuCostUsd(gpuSeconds: number, usdPerHour: number): number {
  if (gpuSeconds < 0 || usdPerHour < 0) throw new Error('GPU cost inputs must not be negative.');
  return round((gpuSeconds / 3600) * usdPerHour);
}

export interface Reconciliation {
  agrees: boolean;
  recordedUsd: number;
  computedUsd: number;
  differenceUsd: number;
}

/**
 * Whether a lesson's stored total matches the sum of its jobs.
 *
 * Worth checking rather than trusting: the stored figure is written by one
 * transaction per job, so a crash between the job write and the lesson update
 * leaves them disagreeing, and that disagreement is otherwise invisible. A
 * tolerance of a hundredth of a cent absorbs the rounding, nothing more.
 */
export function reconcile(
  recordedUsd: number,
  jobs: readonly JobUsage[],
  toleranceUsd = 0.0001,
): Reconciliation {
  const computedUsd = round(summarise(jobs).totalUsd);
  const differenceUsd = round(Math.abs(recordedUsd - computedUsd));
  return { agrees: differenceUsd <= toleranceUsd, recordedUsd, computedUsd, differenceUsd };
}

export interface BudgetCheck {
  withinBudget: boolean;
  estimateUsd: number;
  budgetUsd: number;
  reason: string | null;
}

/**
 * Whether a lesson may start, given what it is expected to cost.
 *
 * Checked before the expensive stages run, not after — a budget enforced at
 * the end is a report, not a control. `spentUsd` is included so a resumed
 * lesson is measured against what it has already used rather than starting
 * its allowance again.
 */
export function checkBudget(
  estimateUsd: number,
  budgetUsd: number,
  spentUsd = 0,
): BudgetCheck {
  const projected = round(estimateUsd + spentUsd);
  if (budgetUsd <= 0) {
    return { withinBudget: false, estimateUsd: projected, budgetUsd, reason: 'No budget is configured.' };
  }
  if (projected > budgetUsd) {
    return {
      withinBudget: false, estimateUsd: projected, budgetUsd,
      reason: `Projected ${projected.toFixed(4)} USD exceeds the ${budgetUsd.toFixed(4)} USD budget.`,
    };
  }
  return { withinBudget: true, estimateUsd: projected, budgetUsd, reason: null };
}

/**
 * The animation cap a style allows, and whether a plan respects it.
 *
 * Mirrors `animatedSceneCap` in the provider policy and the database's own
 * caps. Checked before any clip is submitted, because the cap is the main
 * thing standing between a lesson and an unbounded video bill.
 */
export function checkAnimationCap(
  requestedAnimatedScenes: number,
  cap: number,
): { withinCap: boolean; reason: string | null } {
  if (requestedAnimatedScenes > cap) {
    return {
      withinCap: false,
      reason: `${requestedAnimatedScenes} animated scenes requested; this style allows ${cap}.`,
    };
  }
  return { withinCap: true, reason: null };
}

/** Per-mode comparison, for the report the cost model is argued from. */
export interface ModeSummary {
  mode: string;
  pictures: number;
  animatedScenes: number;
  gpuSeconds: number;
  usdPerLesson: number;
  lessonsPerGpuHour: number;
}

/**
 * Expected cost of each generation mode on our own hardware.
 *
 * Image and clip seconds are measured on an RTX 6000 Ada
 * (`ops/runpod/results-2026-09-21.csv`); planning, speech and the per-picture
 * vision check are estimates, which is why every figure this returns is an
 * estimate and the function says so in its name's absence of "measured".
 */
export function estimateModes(
  usdPerHour: number,
  timings = { imageSeconds: 4.03, clipSeconds: 48.15, planSeconds: 20, speechSeconds: 45, visionSecondsPerPicture: 2 },
): ModeSummary[] {
  const modes = [
    { mode: 'deterministic', pictures: 8, animatedScenes: 0 },
    { mode: 'storybook', pictures: 16, animatedScenes: 2 },
    { mode: 'illustrated', pictures: 8, animatedScenes: 3 },
    { mode: 'editorial', pictures: 8, animatedScenes: 6 },
  ];
  return modes.map(({ mode, pictures, animatedScenes }) => {
    const gpuSeconds = round(
      timings.planSeconds + timings.speechSeconds
      + pictures * (timings.imageSeconds + timings.visionSecondsPerPicture)
      + animatedScenes * timings.clipSeconds,
    );
    return {
      mode, pictures, animatedScenes, gpuSeconds,
      usdPerLesson: gpuCostUsd(gpuSeconds, usdPerHour),
      lessonsPerGpuHour: round(3600 / gpuSeconds),
    };
  });
}
