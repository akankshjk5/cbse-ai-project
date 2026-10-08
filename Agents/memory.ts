/**
 * The run's working memory: a scratchpad the specialists share, and the trace
 * a human reads afterwards.
 *
 * Two jobs, deliberately in one object.
 *
 * 1. **A blackboard.** The specialists never talk to each other directly —
 *    each one is a single-shot call that returns a validated object and then
 *    forgets everything. Without somewhere to put what it learned, stage four
 *    cannot know what stage one decided except by whatever the Manager
 *    remembers to hand forward. `note()` / `recall()` is that somewhere, and
 *    `digest()` is what gets pasted into every downstream prompt.
 *
 * 2. **A transcript.** Steps, results, errors, model reasoning and the
 *    handoffs between stages, in order, so a failed build can be read back.
 *
 * It is deliberately temporary. A run's memory lives in a process-level cache
 * keyed by run id, and `disposeMemory()` deletes it once the .pptx exists — it
 * holds prompts, research notes and reasoning traces, none of which have any
 * business outliving the deck they were for. Artefacts (images, the .pptx) are
 * referenced by path, never stored here.
 */

export type MemoryEntryType = 'step' | 'result' | 'error' | 'reasoning' | 'handoff';

export interface MemoryEntry {
  timestamp: string;
  type: MemoryEntryType;
  /** Pipeline stage that produced it, when one is known. */
  stage?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Notified as each entry is recorded, for live logging. */
export type MemoryListener = (entry: MemoryEntry) => void;

/**
 * Well-known blackboard keys.
 *
 * Constants rather than bare strings so a typo is a compile error instead of a
 * silently-empty `recall()` three stages later.
 */
export const MEMORY_KEYS = {
  brief: 'brief',
  research: 'research',
  outline: 'outline',
  style: 'style',
  imagery: 'imagery',
  fonts: 'fonts',
} as const;

export type MemoryKey = (typeof MEMORY_KEYS)[keyof typeof MEMORY_KEYS];

/** How much of one note is pasted into a downstream prompt. */
const DIGEST_CHARS = 1200;
/** How much of a single reasoning burst is kept. Full traces are megabytes. */
const REASONING_CHARS = 4000;

export class Memory {
  private readonly entries: MemoryEntry[] = [];
  private readonly board = new Map<string, unknown>();
  /** The stage currently running, so entries attribute themselves. */
  private stage = 'manager';

  /**
   * `onEntry` exists so a run can be watched as it happens rather than only
   * summarised at the end — a build takes minutes, and a trace printed after
   * it finishes is no help while you are waiting to see where it is.
   */
  constructor(private readonly onEntry?: MemoryListener) {}

  private add(type: MemoryEntryType, message: string, metadata?: Record<string, unknown>) {
    const entry: MemoryEntry = {
      timestamp: new Date().toISOString(),
      type,
      stage: this.stage,
      message,
      metadata,
    };

    this.entries.push(entry);
    // A listener that throws must not take the build down with it.
    try {
      this.onEntry?.(entry);
    } catch {
      /* ignore */
    }
  }

  step(message: string, metadata?: Record<string, unknown>) {
    this.add('step', message, metadata);
  }

  result(message: string, metadata?: Record<string, unknown>) {
    this.add('result', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>) {
    this.add('error', message, metadata);
  }

  /**
   * A model's own thinking, as it arrives.
   *
   * Recorded rather than printed directly so it interleaves with the rest of
   * the trace in order — reading "why did it pick that font" is only useful
   * next to the step that asked.
   */
  reasoning(stage: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.add(
      'reasoning',
      trimmed.length > REASONING_CHARS ? `${trimmed.slice(0, REASONING_CHARS)}…` : trimmed,
      { of: stage },
    );
  }

  /**
   * One stage handing work to the next.
   *
   * This is the closest thing the pipeline has to the specialists talking to
   * each other, so it is its own kind of entry: in a trace of forty lines
   * these are the six that describe the shape of the run.
   */
  handoff(from: string, to: string, summary: string) {
    this.add('handoff', `${from} → ${to} — ${summary}`, { from, to });
  }

  /** Marks which stage subsequent entries belong to. Returns the previous one. */
  enter(stage: string): string {
    const previous = this.stage;
    this.stage = stage;
    return previous;
  }

  // ── Blackboard ─────────────────────────────────────────────────────────────

  /** Writes a shared fact every later stage can read. */
  note(key: MemoryKey | string, value: unknown) {
    this.board.set(key, value);
  }

  recall<T = unknown>(key: MemoryKey | string): T | undefined {
    return this.board.get(key) as T | undefined;
  }

  /**
   * The shared context, rendered for a prompt.
   *
   * Every specialist gets this, which is what stops stage five contradicting
   * stage two. Each note is truncated: the point is continuity, not a second
   * copy of the whole state — the Manager still passes the objects a stage
   * actually needs as its own arguments.
   */
  digest(keys?: (MemoryKey | string)[]): string {
    const wanted = keys ?? [...this.board.keys()];
    const parts: string[] = [];

    for (const key of wanted) {
      if (!this.board.has(key)) continue;

      const value = this.board.get(key);
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      if (!rendered) continue;

      const body =
        rendered.length > DIGEST_CHARS ? `${rendered.slice(0, DIGEST_CHARS)}…` : rendered;
      parts.push(`## ${key}\n${body}`);
    }

    if (parts.length === 0) return '';

    return ['# Shared working memory (what earlier stages established)', ...parts].join('\n\n');
  }

  all(): readonly MemoryEntry[] {
    return this.entries;
  }

  /** Plain-text trace of the run, for logs and debugging. */
  summary(): string {
    return this.entries
      .map((e) => `[${e.type}${e.stage ? ` ${e.stage}` : ''}] ${e.message}`)
      .join('\n');
  }

  /** Drops everything. The cache entry itself is removed by `disposeMemory`. */
  clear() {
    this.entries.length = 0;
    this.board.clear();
  }
}

// ── The temporary cache ──────────────────────────────────────────────────────

/**
 * Live runs, keyed by run id.
 *
 * A module-level Map is the cache: per-process, alive for exactly as long as
 * the build, and reachable from anywhere in the pipeline without threading a
 * handle through every signature. Nothing here is persisted — `agent_runs` is
 * the durable record, and it is written as the run happens rather than swept
 * out of this at the end.
 */
const RUNS = new Map<string, Memory>();

/** Opens (or re-attaches to) the working memory for one build. */
export function openMemory(runId: string, onEntry?: MemoryListener): Memory {
  const existing = RUNS.get(runId);
  if (existing) return existing;

  const memory = new Memory(onEntry);
  RUNS.set(runId, memory);
  return memory;
}

export function peekMemory(runId: string): Memory | undefined {
  return RUNS.get(runId);
}

/**
 * Deletes a run's memory.
 *
 * Called once the .pptx exists, from a `finally` — a build that throws must
 * not leave its research notes and reasoning traces resident in a long-lived
 * server process. Safe to call twice.
 */
export function disposeMemory(runId: string): void {
  RUNS.get(runId)?.clear();
  RUNS.delete(runId);
}

/** How many runs are currently holding memory. Diagnostics only. */
export function liveMemoryCount(): number {
  return RUNS.size;
}
