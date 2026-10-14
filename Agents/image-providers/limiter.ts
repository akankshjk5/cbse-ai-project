/**
 * A FIFO concurrency limiter.
 *
 * Image APIs rate-limit per key, and a build that fires a dozen requests at once
 * trips the limit for every other build sharing that key. One limiter per
 * provider, shared by the whole process, turns "N builds x M images" into "at
 * most `max` requests in flight" — the rest wait their turn instead of failing.
 *
 * It is per *process*. Across several app instances the cap multiplies, which is
 * the point at which the work belongs in a shared queue rather than here.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Limiter max must be a positive integer, got ${max}`);
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const REGISTRY_KEY = Symbol.for('lumina.imageLimiters');

/**
 * One shared limiter per key, surviving dev-server module reloads.
 * `globalThis` rather than a module variable: Next may evaluate this module more
 * than once, and two limiters for one API key is no limiter.
 */
export function limiterFor(key: string, max: number): Limiter {
  const holder = globalThis as unknown as Record<symbol, Map<string, Limiter> | undefined>;
  const registry = (holder[REGISTRY_KEY] ??= new Map<string, Limiter>());
  const existing = registry.get(key);
  if (existing && existing.max === max) return existing;
  const created = new Limiter(max);
  registry.set(key, created);
  return created;
}
