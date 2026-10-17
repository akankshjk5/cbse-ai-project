/**
 * Check a machine's configuration without ever printing a secret.
 *
 *   npm run doctor                 # presence, shape, policy, git hygiene
 *   npm run doctor -- --services   # also probe the loopback model services
 *   npm run doctor -- --auth       # also verify credentials actually authenticate
 *
 * Three rules this script is built around:
 *
 *  1. A value is never printed, logged, or put in an error message. Secrets are
 *     reported as `set` or `MISSING` and, where the shape is known, as a
 *     pass/fail on that shape. No prefixes, no lengths, no fingerprints — a
 *     length narrows a brute force and a prefix identifies the account.
 *  2. An environment variable being set is not evidence the integration works,
 *     so `--auth` makes one real authentication call per configured provider
 *     against a metadata endpoint that generates nothing and bills nothing.
 *     Response bodies are discarded; only the status class is reported.
 *  3. It cannot become a way around the provider policy. `--auth` probes a
 *     paid provider only when ALLOW_EXTERNAL_PROVIDERS and EXTERNAL_PROVIDERS
 *     already name that stage, and it never calls a generation endpoint.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// `admission.ts` imports `server-only`, so it cannot load in a plain Node
// script. Reading the policy modules it is built on gives the same answer
// without pretending this process is a Next.js server.
import {
  GENERATION_STAGES,
  type GenerationStage,
  policyEnv,
  resolveStage,
} from '../src/lib/generation/providers/policy.ts';
import { generatorIdFromEnv } from '../src/lib/generation/providers/registry.ts';
import { ENV_VARS, WORKER_VARS, type EnvVar, type Scope } from '../src/lib/env-inventory.ts';

const flags = new Set(process.argv.slice(2));
const want = (f: string) => flags.has(`--${f}`);

let failures = 0;
let warnings = 0;

function fail(message: string): void { failures += 1; console.log(`  FAIL  ${message}`); }
function warn(message: string): void { warnings += 1; console.log(`  warn  ${message}`); }
function ok(message: string): void { console.log(`  ok    ${message}`); }
function heading(title: string): void { console.log(`\n${title}\n${'─'.repeat(title.length)}`); }

/**
 * Presence and shape, never the value.
 *
 * `shape` runs against the real value in memory and only its boolean result
 * leaves this function, so a malformed key is caught without anyone having to
 * look at one.
 */
function inspect(v: EnvVar): 'set' | 'missing' | 'malformed' {
  const raw = process.env[v.name];
  if (raw === undefined || raw.trim() === '') return 'missing';
  if (v.shape && !v.shape.test(raw.trim())) return 'malformed';
  return 'set';
}

// ── 1. Git hygiene ─────────────────────────────────────────────────────────
// Checked first: a tracked secret is the one finding that cannot be undone by
// fixing configuration, because it is already in everyone's clone.

heading('1. Git hygiene');

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const trackedEnv = tracked.filter((f) => /(^|\/)\.env/.test(f) && !/\.env\.example$/.test(f));
if (trackedEnv.length) fail(`real env files are tracked by git: ${trackedEnv.join(', ')}`);
else ok('no .env file is tracked; only .env.example templates are');

/** `git check-ignore` signals the answer through its exit status, not stdout. */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const shouldIgnore = ['.env', '.env.local', '.env.production.local', '.runpod-worker.env'];
const unignored = shouldIgnore.filter((c) => !isIgnored(c));
if (unignored.length) fail(`not covered by .gitignore: ${unignored.join(', ')}`);
else ok(`.gitignore covers ${shouldIgnore.join(', ')}`);

// A secret-shaped value behind a NEXT_PUBLIC_ name is the breach that matters
// most here, because the bundler inlines it into JavaScript the browser keeps.
const publicSecretShapes: Array<[string, RegExp]> = [
  ['service-role / JWT secret', /^(sb_secret_|eyJ[A-Za-z0-9_-]{20,}\.)/],
  ['Clerk secret key', /^sk_(test|live)_/],
  ['OpenRouter key', /^sk-or-v1-/],
  ['Google API key', /^AIza/],
  ['Vertex express key', /^AQ\./],
  ['webhook signing secret', /^whsec_/],
];
let leaked = 0;
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith('NEXT_PUBLIC_') || !value) continue;
  for (const [kind, shape] of publicSecretShapes) {
    if (shape.test(value.trim())) { fail(`${name} holds something shaped like a ${kind} — it is in the browser bundle. Rotate it and move it server-side.`); leaked += 1; }
  }
}
if (leaked === 0) ok('no NEXT_PUBLIC_ variable in this process holds a secret-shaped value');

// ── 2. Variable inventory ──────────────────────────────────────────────────

heading('2. Variables, by where they belong');

const order: Scope[] = ['client', 'server', 'worker', 'tooling'];
const missingRequired: string[] = [];
const missingPath: string[] = [];
const malformed: string[] = [];

for (const scope of order) {
  const rows = ENV_VARS.filter((v) => v.scope === scope);
  if (!rows.length) continue;
  console.log(`\n  ${scope}`);
  for (const v of rows) {
    if (v.name.includes('<')) { console.log(`    ${'-'.padEnd(10)}${v.name}  (dynamic name)`); continue; }
    const state = inspect(v);
    if (state === 'malformed') malformed.push(v.name);
    if (state === 'missing' && v.need === 'required') missingRequired.push(v.name);
    if (state === 'missing' && v.need === 'path') missingPath.push(v.name);
    const mark = state === 'set' ? 'set' : state === 'malformed' ? 'MALFORMED' : v.need === 'required' ? 'MISSING' : '-';
    const tag = v.secret ? ' [secret]' : '';
    console.log(`    ${mark.padEnd(10)}${v.name}${tag}`);
  }
}

console.log('\n  worker process (set these on the GPU host, not in the web app)');
for (const v of WORKER_VARS) {
  const state = inspect(v);
  console.log(`    ${(state === 'set' ? 'set' : '-').padEnd(10)}${v.name}${v.secret ? ' [secret]' : ''}`);
}

heading('3. What is missing, by name');

if (missingRequired.length) fail(`required for any deployment: ${missingRequired.join(', ')}`);
else ok('every variable required for a default deployment is set');

if (malformed.length) fail(`set but does not match the documented shape: ${malformed.join(', ')}`);
else ok('every variable that is set matches its documented shape');

if (missingPath.length) {
  console.log(`  note  needed only on a path you may not be using: ${missingPath.join(', ')}`);
}

// ── 4. Template drift ──────────────────────────────────────────────────────
// `.env.example` is what a new machine is set up from, so a variable the code
// reads but the template omits is a setup failure waiting to happen.

heading('4. .env.example against the code');

async function keysOf(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.split('\n').map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1]).filter((k): k is string => Boolean(k));
}

const webKeys = await keysOf('.env.example');
const workerKeys = await keysOf('ops/runpod/.env.example');

const dupes = webKeys.filter((k, i) => webKeys.indexOf(k) !== i);
if (dupes.length) warn(`declared more than once in .env.example (the later line wins): ${[...new Set(dupes)].join(', ')}`);
else ok('.env.example declares each variable once');

const documented = new Set([...ENV_VARS, ...WORKER_VARS].map((v) => v.name));
const undocumented = webKeys.filter((k) => !documented.has(k));
if (undocumented.length) warn(`in .env.example but not in the inventory: ${undocumented.join(', ')}`);
else ok('every .env.example key has an inventory row');

const webScoped = ENV_VARS.filter((v) => v.scope !== 'tooling' && !v.name.includes('<'));
const absent = webScoped.filter((v) => !webKeys.includes(v.name)).map((v) => v.name);
if (absent.length) warn(`read by the app but absent from .env.example: ${absent.join(', ')}`);
else ok('every app variable appears in .env.example');

const workerAbsent = WORKER_VARS.filter((v) => !workerKeys.includes(v.name)).map((v) => v.name);
if (workerAbsent.length) warn(`read by the worker but absent from ops/runpod/.env.example: ${workerAbsent.join(', ')}`);
else ok('every worker variable appears in ops/runpod/.env.example');

if (process.env.LUMINA_TEST_SEAM === '1') {
  fail('LUMINA_TEST_SEAM=1 is set in this environment. It opens provider injection and must '
    + 'never be set on a serving host. Unset it outside the test scripts.');
}

// ── 5. Resolved policy ─────────────────────────────────────────────────────

heading('5. Which providers this machine will actually use');

const paidStages: GenerationStage[] = [];
let generator: string;
let refused = false;
try {
  generator = generatorIdFromEnv(process.env.LESSON_GENERATOR);
} catch (error) {
  // A bad name is refused rather than defaulted, so the line below must not
  // read as "it will quietly run on local".
  generator = 'REFUSED';
  refused = true;
  fail(error instanceof Error ? error.message : 'LESSON_GENERATOR is invalid');
}
console.log(`  generator: ${generator}`);
for (const stage of GENERATION_STAGES) {
  const p = resolveStage(stage, policyEnv());
  if (p.kind === 'external') paidStages.push(stage);
  console.log(`  ${stage.padEnd(8)} ${p.kind.padEnd(14)} ${p.id} / ${p.model}${p.kind === 'external' ? '  PAID' : ''}`);
}
// The same refusal `admitGeneration` would return, restated here because the
// route-level gate cannot be imported into a plain Node process.
if (generator === 'cloud' && paidStages.length === 0) {
  refused = true;
  fail('LESSON_GENERATOR=cloud needs ALLOW_EXTERNAL_PROVIDERS=true and stages named in '
    + 'EXTERNAL_PROVIDERS. Every stage would be refused at its factory, so requests are '
    + 'refused up front instead.');
}
if (refused) {
  console.log('  note  generation is refused on this machine, so the stage table above is '
    + 'what it WOULD use once the generator is valid.');
} else if (paidStages.length === 0) {
  ok('no stage is configured to spend money; every stage is self-hosted or deterministic');
} else {
  warn(`paid stages enabled: ${paidStages.join(', ')}`);
}

// ── 6. Loopback services ───────────────────────────────────────────────────
// Opt-in because it is the only check that needs the model stack running, and
// a committee demo machine is often configured before the GPU host exists.

if (want('services')) {
  heading('6. Self-hosted services');

  const services: Array<[string, string, string]> = [
    ['planner', process.env.LOCAL_VIDEO_AGENT_URL ?? 'http://127.0.0.1:18080', '/health'],
    ['tts', process.env.LOCAL_VIDEO_TTS_URL ?? 'http://127.0.0.1:18081', '/health'],
    ['translation', process.env.LOCAL_VIDEO_TRANSLATION_URL ?? 'http://127.0.0.1:18082', '/health'],
    ['comfyui', process.env.LOCAL_VIDEO_COMFY_URL ?? 'http://127.0.0.1:8188', '/system_stats'],
    ['media worker', process.env.LOCAL_VIDEO_WORKER_URL ?? 'http://127.0.0.1:8090', '/health'],
  ];

  for (const [label, base, path] of services) {
    let url: URL;
    try { url = new URL(path, base); } catch { fail(`${label}: ${base} is not a URL`); continue; }
    // Only loopback is probed by default: a configured remote host may be
    // someone else's machine, and a health probe is still a request to it.
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    if (!loopback && !want('allow-remote')) { warn(`${label}: ${url.hostname} is not loopback; pass --allow-remote to probe it`); continue; }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) ok(`${label}: HTTP ${response.status}`);
      else warn(`${label}: HTTP ${response.status}`);
    } catch {
      warn(`${label}: not reachable at ${url.origin} (service not started?)`);
    }
  }
}

// ── 7. Credential verification ─────────────────────────────────────────────
// The only part that talks to a third party. Each probe is a metadata read:
// it authenticates, generates nothing, and bills nothing. Bodies are dropped.

if (want('auth')) {
  heading('7. Do the credentials authenticate?');

  /** Status class only. A body can echo the key back, so it is never read. */
  async function probe(label: string, url: string, headers: Record<string, string>): Promise<void> {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (response.status === 200) ok(`${label}: authenticated (HTTP 200)`);
      else if (response.status === 401 || response.status === 403) fail(`${label}: rejected the credential (HTTP ${response.status}). Rotate or re-copy it.`);
      else if (response.status === 429) warn(`${label}: authenticated but rate-limited (HTTP 429)`);
      else warn(`${label}: unexpected HTTP ${response.status}`);
    } catch (error) {
      // The message is ours, not the provider's: an upstream error string can
      // contain the request URL, and a request URL can contain a key.
      warn(`${label}: request failed (${error instanceof Error ? error.name : 'unknown'})`);
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (supabaseUrl && serviceKey) {
    // PostgREST's root returns the OpenAPI document for an authenticated
    // request and 401 otherwise. Free, and it touches no table.
    await probe('supabase service role', `${supabaseUrl}/rest/v1/`, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });
  } else {
    console.log(`  skip  supabase: ${!supabaseUrl ? 'NEXT_PUBLIC_SUPABASE_URL' : 'SUPABASE_SERVICE_ROLE_KEY'} is not set`);
  }

  const clerk = process.env.CLERK_SECRET_KEY?.trim();
  if (clerk) await probe('clerk backend api', 'https://api.clerk.com/v1/instance', { Authorization: `Bearer ${clerk}` });
  else console.log('  skip  clerk: CLERK_SECRET_KEY is not set');

  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    // /api/v1/key returns the key's own limits. No model is invoked.
    await probe('openrouter', 'https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${openrouter}` });
  } else console.log('  skip  openrouter: OPENROUTER_API_KEY is not set (needed only for the deck pipeline)');

  // Paid generation providers are probed only when the policy already allows
  // them, so this script cannot be used to exercise a provider the deployment
  // has not opted into.
  const enabled = new Set(paidStages);
  const geminiStages = ['plan', 'image', 'speech'].filter((s) => enabled.has(s as never));
  const geminiKey = process.env.GEMINI_API_KEY?.trim() ?? process.env.GOOGLE_VERTEX_API_KEY?.trim();
  if (geminiStages.length === 0) {
    console.log('  skip  gemini: no Gemini stage is enabled by the provider policy');
  } else if (!geminiKey) {
    const which = geminiStages.length === 1 ? `stage ${geminiStages[0]} is` : `stages ${geminiStages.join(', ')} are`;
    fail(`gemini: ${which} enabled but GEMINI_API_KEY / GOOGLE_VERTEX_API_KEY is missing`);
  } else {
    // Listing models authenticates without generating. The key goes in a
    // header, never in the query string.
    await probe('gemini', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': geminiKey });
  }

  if (!enabled.has('motion')) {
    console.log('  skip  higgsfield: the motion stage is not enabled by the provider policy');
  } else if (!process.env.HF_CREDENTIALS?.trim() && !process.env.HF_KEY?.trim()) {
    fail('higgsfield: the motion stage is enabled but no HF_CREDENTIALS / HF_KEY is set');
  } else {
    // Higgsfield publishes no free metadata endpoint, and its cheapest real
    // call submits a billable job. So this stays unverified rather than
    // quietly spending money to prove a key works.
    warn('higgsfield: credentials are present but cannot be verified without a billable '
      + 'request, so this integration stays UNVERIFIED until a human runs one deliberately');
  }
} else {
  heading('7. Credential verification');
  console.log('  skipped. Pass --auth to make one metadata-only authentication call per');
  console.log('  configured provider. Until then, "set" above means present, not working.');
}

// ── Summary ────────────────────────────────────────────────────────────────

heading('Summary');
console.log(`  ${failures} failure(s), ${warnings} warning(s)`);
if (failures === 0 && warnings === 0) console.log('\n  This machine matches the configuration contract.');
if (failures > 0) console.log('\n  Fix the failures above before a demo. Nothing printed here contains a secret.');
process.exit(failures > 0 ? 1 : 0);
