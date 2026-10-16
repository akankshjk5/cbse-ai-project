/**
 * The one door a test may use to substitute a provider client, and the reason
 * production cannot use it.
 *
 * Several modules accept an injected transport so a test can drive them
 * without a network. That injection skipped the guarded factory, and with it
 * the paid-provider policy — so production code could reach Gemini by handing
 * in its own transport, bypassing a rule the rest of the system enforces. A
 * comment saying "tests only" is not a control.
 *
 * Trust here is a chain with exactly two roots:
 *
 *   1. `markFactoryBuilt` — what a guarded factory returns. The factory has
 *      already applied the external-provider policy, so its output is
 *      legitimate by construction.
 *   2. `resolveInjected` with the seam open — a test's stub. The seam is
 *      `LUMINA_TEST_SEAM=1`, read at the moment of injection rather than at
 *      import, so it cannot be set by a module that loaded earlier and it is
 *      visible in any process listing.
 *
 * Everything else is DERIVED. A worker that wraps a transport to add
 * heartbeats or cost metering calls `deriveTrusted`, which requires the thing
 * being wrapped to be trusted already. So every chain terminates at a factory
 * or at a test, and production — which cannot set the variable — cannot start
 * one of its own.
 *
 * The registry is a `WeakSet`, so trust cannot be forged by copying: an object
 * built by spreading a trusted one (`{ ...real, generateContent: mine }`) is a
 * different object and was never registered.
 */

const trusted = new WeakSet<object>();

export class ProviderBypassRefused extends Error {
  constructor(what: string) {
    super(
      `Refusing an injected ${what}: injection is a test-only seam. `
      + 'Production code must obtain a provider from its guarded factory so the '
      + 'external-provider policy applies. A test sets LUMINA_TEST_SEAM=1.',
    );
    this.name = 'ProviderBypassRefused';
  }
}

/** Read per call, never cached, so the gate cannot be flipped at import time. */
export function testSeamEnabled(): boolean {
  return process.env.LUMINA_TEST_SEAM === '1';
}

/** Root: what a guarded factory just built. */
export function markFactoryBuilt<T extends object>(value: T): T {
  trusted.add(value);
  return value;
}

/**
 * Root: a test's stub.
 *
 * Throws outside a test, so an accidental production call fails at the point
 * of the mistake rather than somewhere downstream.
 */
export function testDouble<T extends object>(value: T): T {
  if (!testSeamEnabled()) throw new ProviderBypassRefused('provider double');
  trusted.add(value);
  return value;
}

/**
 * A wrapper around something already trusted.
 *
 * Trust is derived, never granted: the parent must already be trusted, so a
 * caller cannot launder its own object into the chain by wrapping it.
 */
export function deriveTrusted<T extends object>(parent: object, wrapper: T, what: string): T {
  if (!trusted.has(parent)) throw new ProviderBypassRefused(what);
  trusted.add(wrapper);
  return wrapper;
}

/**
 * The client a call should use: the injected one when the seam is open,
 * otherwise whatever the guarded factory returns.
 *
 * One helper, so every injection point resolves identically and a new one
 * cannot implement half the rule. The factory callback is lazy, so a test that
 * injects never constructs a real client and never trips the paid-provider
 * guard it was not testing.
 */
export function resolveInjected<T extends object>(
  injected: T | undefined,
  what: string,
  fromFactory: () => T,
): T {
  if (injected === undefined) return fromFactory();
  if (!testSeamEnabled()) throw new ProviderBypassRefused(what);
  // A stub reaching a module directly, without passing through `testDouble`,
  // still has to be admitted to the chain so wrappers built on it resolve.
  trusted.add(injected);
  return injected;
}
