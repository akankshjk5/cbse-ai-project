import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-model-call telemetry, carried out of the pipeline without wiring a
 * database through it.
 *
 * `Agent.ts` knows about models; it must not know about Supabase, job ids or
 * deck ids. So it emits a record and an AsyncLocalStorage context decides what
 * happens to it: in the app that is a row in `agent_runs`, in a smoke test it
 * is nothing at all.
 *
 * AsyncLocalStorage rather than a parameter threaded through every specialist,
 * because the alternative is `jobId` in the signature of every function between
 * the bridge and the model call — including the ones that have no business
 * knowing a job exists.
 */

export interface AgentRunRecord {
  /** Pipeline stage — 'style-analyzer', 'font-curator', ... */
  agent: string;
  /** 0 for the first try; 1 for the schema-validation retry. */
  attempt: number;
  status: 'succeeded' | 'failed';
  model: string;
  /** Prompts as sent. Telemetry is owner-read-only, so this is safe to keep. */
  input: unknown;
  output?: unknown;
  /**
   * The model's own thinking for this call, when it emitted any.
   *
   * Carried here because a stage that produced a bad plan is only debuggable
   * if you can read the argument it made to itself. Consumed by the sink —
   * today the terminal; `agent_runs` has no column for it.
   */
  reasoning?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  latencyMs: number;
  error?: string;
}

export type TelemetrySink = (record: AgentRunRecord) => void | Promise<void>;

interface Context {
  sink: TelemetrySink;
  /** In-flight sink calls, so `withTelemetry` can wait for them to land. */
  pending: Set<Promise<void>>;
}

const storage = new AsyncLocalStorage<Context>();

/**
 * Runs `fn` with every model call inside it reported to `sink`.
 *
 * Resolves only once the sink has finished with every record, so a caller that
 * rolls totals up afterwards sees all of them. Records are still emitted
 * without blocking the pipeline — the waiting happens here, at the end, not at
 * each call site.
 */
export async function withTelemetry<T>(sink: TelemetrySink, fn: () => Promise<T>): Promise<T> {
  const context: Context = { sink, pending: new Set() };

  try {
    return await storage.run(context, fn);
  } finally {
    await Promise.allSettled(context.pending);
  }
}

/**
 * Emits one record, if anything is listening.
 *
 * Never throws and never blocks the caller: a telemetry write that fails must
 * cost a row in a reporting table, not the deck the user is waiting for.
 */
export function recordAgentRun(record: AgentRunRecord): void {
  const context = storage.getStore();
  if (!context) return;

  try {
    const settled = Promise.resolve(context.sink(record))
      .catch(() => {})
      .finally(() => context.pending.delete(settled));

    context.pending.add(settled);
  } catch {
    // A sink that throws synchronously is still the sink's problem, not ours.
  }
}
