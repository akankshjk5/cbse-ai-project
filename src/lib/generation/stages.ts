/**
 * The build's stages, in the order the Manager reports them.
 *
 * Shared by the server (which stamps `generation_jobs.progress`) and the card
 * (which needs to know where the NEXT stage sits, so it can creep the bar
 * towards it instead of sitting still for minutes). Keeping one ordered list
 * means the two can never disagree about how far along a stage is.
 *
 * No imports: this is pulled into a Client Component.
 */

export const STAGES = [
  { key: 'queued', progress: 0.02, label: 'Queued' },
  { key: 'researching', progress: 0.08, label: 'Researching the topic' },
  { key: 'planning', progress: 0.2, label: 'Planning slides' },
  // The review gate. The bar stops here until a person approves the outline,
  // which is deliberate: the stages after it are where the money goes.
  { key: 'awaiting-review', progress: 0.25, label: 'Waiting for your review' },
  { key: 'analyzing-style', progress: 0.32, label: 'Reading your reference image' },
  { key: 'designing', progress: 0.45, label: 'Writing the slides' },
  { key: 'illustrating', progress: 0.62, label: 'Drawing the images' },
  { key: 'generating', progress: 0.8, label: 'Choosing fonts and building the PowerPoint' },
  { key: 'reviewing', progress: 0.9, label: 'Checking the layout' },
  { key: 'complete', progress: 0.97, label: 'Finishing up' },
] as const;

/**
 * A revision loops back to designing, so it is not part of the forward
 * sequence — it reports its own position and its own words.
 */
const REVISING = { key: 'revising', progress: 0.5, label: 'Fixing layout issues' } as const;

const BY_KEY = new Map<string, { progress: number; label: string }>([
  ...STAGES.map((stage) => [stage.key, stage] as const),
  [REVISING.key, REVISING],
]);

export function progressForStage(stage: string): number {
  return BY_KEY.get(stage)?.progress ?? 0.5;
}

export function labelForStage(stage: string): string {
  return BY_KEY.get(stage)?.label ?? 'Working';
}

/**
 * Where the bar is allowed to creep to while this stage runs.
 *
 * Just short of the next stage's mark, so the bar keeps moving without ever
 * promising progress that has not happened. A stage with nothing after it
 * (or an unknown one) creeps a little and stops.
 */
export function ceilingForStage(stage: string): number {
  const index = STAGES.findIndex((entry) => entry.key === stage);
  const next = index >= 0 ? STAGES[index + 1] : undefined;

  if (next) return next.progress - 0.02;
  return Math.min(0.95, progressForStage(stage) + 0.08);
}
