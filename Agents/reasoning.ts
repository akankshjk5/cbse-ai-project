import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The model's own thinking, carried out of the pipeline.
 *
 * Same shape and same reason as `telemetry.ts`: `Agent.ts` knows how to talk
 * to a model and must not know what a Memory or a deck is, so it emits
 * reasoning deltas into an AsyncLocalStorage context and whoever opened that
 * context decides where they go. In a build that is the run's working memory
 * (and from there, the terminal); in a smoke test it is nowhere.
 *
 * Reasoning is what makes a failed build legible. "Generation failed" tells
 * you nothing; the slide designer talking itself into a 14-inch text box on a
 * 13.3-inch canvas tells you everything.
 */

export type ReasoningSink = (stage: string, delta: string) => void;

const storage = new AsyncLocalStorage<ReasoningSink>();

/** Runs `fn` with every model call's reasoning inside it reported to `sink`. */
export async function withReasoning<T>(sink: ReasoningSink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

/**
 * Emits one reasoning delta, if anything is listening.
 *
 * Never throws: a logging sink that fails must not cost the deck.
 */
export function recordReasoning(stage: string, delta: string): void {
  const sink = storage.getStore();
  if (!sink) return;

  try {
    sink(stage, delta);
  } catch {
    /* a sink that throws is the sink's problem */
  }
}

/** Whether anything is listening — lets a caller skip consuming the stream. */
export function isReasoningWatched(): boolean {
  return storage.getStore() !== undefined;
}
