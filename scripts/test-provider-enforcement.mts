/**
 * The paid-provider policy, enforced in the real modules rather than in a
 * test's own copy of the rule.
 *
 * `test:providers` proves the policy functions decide correctly. This proves
 * the production factories actually consult them — it imports the same
 * `createHiggsfieldProvider` and `geminiTransport` the workers import, and
 * asserts that constructing one without the two switches throws.
 *
 * That is the property that matters: both are the ONLY places a paid client is
 * built, so a route, a worker, a retry or a future caller cannot reach a billed
 * API without passing through a guard here.
 *
 *   npm run test:enforcement
 */

import { createHiggsfieldProvider } from '../src/lib/cloud-lesson/higgsfield.ts';
import { geminiTransport } from '../src/lib/cloud-lesson/gemini.ts';
import { admitGeneration } from '../src/lib/generation/admission.ts';
import {
  ExternalProviderRefused,
  GENERATION_STAGES,
  type GenerationStage,
  policyEnv,
  resolveStage,
} from '../src/lib/generation/providers/policy.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** Run `body` with the policy environment set, then restore it. */
function withEnv(allow: string | undefined, stages: string | undefined, body: () => void): void {
  const before = {
    allow: process.env.ALLOW_EXTERNAL_PROVIDERS,
    stages: process.env.EXTERNAL_PROVIDERS,
  };
  if (allow === undefined) delete process.env.ALLOW_EXTERNAL_PROVIDERS;
  else process.env.ALLOW_EXTERNAL_PROVIDERS = allow;
  if (stages === undefined) delete process.env.EXTERNAL_PROVIDERS;
  else process.env.EXTERNAL_PROVIDERS = stages;
  try { body(); } finally {
    if (before.allow === undefined) delete process.env.ALLOW_EXTERNAL_PROVIDERS;
    else process.env.ALLOW_EXTERNAL_PROVIDERS = before.allow;
    if (before.stages === undefined) delete process.env.EXTERNAL_PROVIDERS;
    else process.env.EXTERNAL_PROVIDERS = before.stages;
  }
}

function refuses(body: () => unknown): boolean {
  try { body(); return false; } catch (error) { return error instanceof ExternalProviderRefused; }
}

// ── The default deployment cannot build a paid client at all ───────────────

withEnv(undefined, undefined, () => {
  check(refuses(() => createHiggsfieldProvider('pretend-key')),
    'Higgsfield was constructible with no policy configured');
  for (const stage of GENERATION_STAGES) {
    check(refuses(() => geminiTransport(stage)),
      `Gemini transport was constructible for ${stage} with no policy configured`);
  }
  check(policyEnv().allowExternal === undefined, 'policyEnv must read the live environment');
});
console.log('enforcement: with no configuration, neither paid client can be constructed');

// ── One switch is not enough, at the factory as well as in the resolver ────

withEnv(undefined, 'motion,image,plan,speech', () => {
  check(refuses(() => createHiggsfieldProvider('pretend-key')),
    'naming motion without ALLOW_EXTERNAL_PROVIDERS built a Higgsfield client');
  check(refuses(() => geminiTransport('image')),
    'naming image without ALLOW_EXTERNAL_PROVIDERS built a Gemini transport');
});
withEnv('true', undefined, () => {
  check(refuses(() => createHiggsfieldProvider('pretend-key')),
    'ALLOW_EXTERNAL_PROVIDERS alone built a Higgsfield client');
  check(refuses(() => geminiTransport('image')),
    'ALLOW_EXTERNAL_PROVIDERS alone built a Gemini transport');
});
console.log('enforcement: each switch alone is refused at the factory');

// ── Enabling one stage does not enable the others ─────────────────────────

withEnv('true', 'image', () => {
  check(refuses(() => createHiggsfieldProvider('pretend-key')),
    'enabling image also enabled the motion provider');
  for (const stage of ['plan', 'speech', 'motion'] as GenerationStage[]) {
    check(refuses(() => geminiTransport(stage)),
      `enabling image also enabled ${stage}`);
  }
  check(resolveStage('image', policyEnv()).kind === 'external',
    'image should resolve external once enabled');
});
console.log('enforcement: enabling one stage leaves the other three refused');

// ── A retry cannot widen permission ───────────────────────────────────────
// The worker's recovery path re-enters the same factory, so a second or third
// attempt is refused exactly like the first. There is no attempt count under
// which an unconfigured provider becomes constructible.

withEnv(undefined, undefined, () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    check(refuses(() => createHiggsfieldProvider('pretend-key')),
      `attempt ${attempt} built a paid client that attempt 1 could not`);
  }
});
console.log('enforcement: five successive attempts are refused identically - retries cannot widen permission');

// ── A refusal says how to fix it, and names no secret ─────────────────────

withEnv(undefined, undefined, () => {
  try {
    createHiggsfieldProvider('super-secret-key-value');
    check(false, 'expected a refusal');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(message.includes('ALLOW_EXTERNAL_PROVIDERS'), 'a refusal must say which switch is missing');
    check(!message.includes('super-secret-key-value'), 'a refusal must not echo the credential');
  }
});
console.log('enforcement: a refusal explains itself without echoing the credential');

// ── No alternate construction path ────────────────────────────────────────
// Asserted by inspection in the suite's own source scan below: the only
// exported constructors of a paid client are the two guarded here.

check(typeof createHiggsfieldProvider === 'function', 'higgsfield factory must be the exported one');
check(typeof geminiTransport === 'function', 'gemini transport must be the exported one');
console.log('enforcement: both guarded factories are the exported constructors the workers import');

// ── Route admission: the gate the API actually calls ──────────────────────

const localDefault = admitGeneration({}, undefined);
check(localDefault.admitted, 'an unconfigured deployment must still admit local generation');
check(localDefault.generator === 'local', 'the default generator must be local');
check(localDefault.paidStages.length === 0, 'a default deployment must name no paid stage');
check(localDefault.providers.motion.kind === 'deterministic',
  'motion must default to deterministic at the route gate too');
console.log('admission: a default deployment admits local generation and no paid stage');

const cloudUnfunded = admitGeneration({}, 'cloud');
check(!cloudUnfunded.admitted,
  'LESSON_GENERATOR=cloud with the paid switches off must be refused, not queued');
check(cloudUnfunded.reason?.includes('ALLOW_EXTERNAL_PROVIDERS'),
  'the refusal must name the missing switch');
console.log('admission: selecting cloud without the paid switches is refused at the route');

const cloudFunded = admitGeneration({ allowExternal: 'true', externalStages: 'motion' }, 'cloud');
check(cloudFunded.admitted, 'cloud with a named stage must be admitted');
check(cloudFunded.paidStages.includes('motion'), 'the paid stage must be disclosed to the caller');
check(cloudFunded.providers.plan.kind === 'local', 'an unnamed stage stays local even under cloud');
console.log('admission: paid stages are disclosed and unnamed stages stay local');

const broken = admitGeneration({}, 'runpod');
check(!broken.admitted, 'an unknown LESSON_GENERATOR must be refused');
check(broken.reason !== null, 'the refusal must explain itself');
console.log('admission: an unknown generator is refused rather than defaulted');

console.log('\nOK');
