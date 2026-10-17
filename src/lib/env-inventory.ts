/**
 * Every environment variable Lumina reads, and where it belongs.
 *
 * This table is the configuration contract. `scripts/doctor.mts` checks a
 * machine against it and verifies `.env.example` against it too, so a variable
 * added to the code without a row here gets reported rather than discovered in
 * production.
 *
 * Nothing here holds a value. `secret: true` means a checker may report only
 * whether the variable is set and whether its shape is plausible — never the
 * value, never a prefix, never a length, in any output, log or commit.
 */

/** Which process reads the variable. The browser sees `client` only. */
export type Scope =
  /** Inlined into the browser bundle at build time. Must never be a secret. */
  | 'client'
  /** The Next.js server: route handlers, Server Actions, server components. */
  | 'server'
  /** A long-running worker: `scripts/*worker*.mts` or `ops/runpod/*.py`. */
  | 'worker'
  /** Developer tooling and tests. Never read by a serving process. */
  | 'tooling';

export type Need =
  /** The process will not start, or its first request throws, without it. */
  | 'required'
  /** Required only when the named path is taken; unused otherwise. */
  | 'path'
  /** Has a working default in code. */
  | 'optional'
  /** Declared but read by no code. Kept for a documented reason. */
  | 'unwired';

export interface EnvVar {
  name: string;
  scope: Scope;
  need: Need;
  /** For `need: 'path'`, what has to be true for this to be needed. */
  when?: string;
  secret: boolean;
  /** Shape test. A checker reports pass/fail only, never the value. */
  shape?: RegExp;
  note: string;
}

const SUPABASE_ORIGIN = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/;
const SUPABASE_SECRET = /^(sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export const ENV_VARS: EnvVar[] = [
  // ── Browser-visible. Everything here ships in the bundle by design. ───────
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL', scope: 'client', need: 'required', secret: false,
    shape: SUPABASE_ORIGIN,
    note: 'Project REST and Storage origin. Public; row-level security is what protects data.',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', scope: 'client', need: 'required', secret: false,
    shape: /^(sb_publishable_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
    note: 'Publishable (anon) key. Grants only what RLS allows. Never the service-role key.',
  },
  {
    name: 'NEXT_PUBLIC_SITE_URL', scope: 'client', need: 'optional', secret: false,
    note: 'Absolute origin for callbacks and share links. Defaults to http://localhost:3000.',
  },
  {
    name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', scope: 'client', need: 'required', secret: false,
    shape: /^pk_(test|live)_[A-Za-z0-9_-]{10,}$/,
    note: "Read by Clerk's own SDK, not through src/lib/env.ts. Publishable by design.",
  },
  {
    name: 'NEXT_PUBLIC_CLERK_SIGN_IN_URL', scope: 'client', need: 'optional', secret: false,
    note: "Route path. Read by Clerk's SDK.",
  },
  {
    name: 'NEXT_PUBLIC_CLERK_SIGN_UP_URL', scope: 'client', need: 'optional', secret: false,
    note: "Route path. Read by Clerk's SDK.",
  },
  {
    name: 'NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL', scope: 'client', need: 'optional',
    secret: false, note: "Route path. Read by Clerk's SDK.",
  },
  {
    name: 'NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL', scope: 'client', need: 'optional',
    secret: false, note: "Route path. Read by Clerk's SDK.",
  },

  // ── Server-only secrets. A NEXT_PUBLIC_ copy of any of these is a breach. ─
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY', scope: 'server', need: 'required', secret: true,
    shape: SUPABASE_SECRET,
    note: 'Bypasses RLS entirely. Used only by src/lib/supabase/admin.ts, and never as a '
      + 'substitute for tenant authorization — every admin query still filters by school.',
  },
  {
    name: 'CLERK_SECRET_KEY', scope: 'server', need: 'required', secret: true,
    shape: /^sk_(test|live)_[A-Za-z0-9_-]{10,}$/,
    note: "Session verification. Clerk's middleware reads it directly from the environment.",
  },
  {
    name: 'CLERK_WEBHOOK_SIGNING_SECRET', scope: 'server', need: 'path', secret: true,
    when: 'a Clerk webhook endpoint is deployed',
    shape: /^whsec_[A-Za-z0-9+/=_-]{20,}$/,
    note: 'Verifies webhook signatures. No handler is wired yet, so it is unused today.',
  },
  {
    name: 'CLERK_INSTANCE_DOMAIN', scope: 'server', need: 'unwired', secret: false,
    note: 'Documented for JWKS pinning in the Supabase third-party-auth config. No code reads it.',
  },

  // ── Deck / PPT pipeline (OpenRouter). The one paid dependency that the ────
  //    default path still has: Agents/Agent.ts and Agents/images.ts need it.
  {
    name: 'OPENROUTER_API_KEY', scope: 'server', need: 'path', secret: true,
    when: 'the deck/PPT pipeline runs (Agents/*)',
    shape: /^sk-or-v1-[0-9a-f]{32,}$/,
    note: 'Required by Agents/Agent.ts and Agents/images.ts. The lesson-video path never reads '
      + 'it; a self-hosted planner replacement for the deck path is still outstanding.',
  },
  { name: 'OPENROUTER_MODEL', scope: 'server', need: 'optional', secret: false, note: 'Planner model override.' },
  { name: 'OPENROUTER_VISION_MODEL', scope: 'server', need: 'optional', secret: false, note: 'Visual-review model override.' },
  { name: 'OPENROUTER_IMAGE_MODEL', scope: 'server', need: 'optional', secret: false, note: 'Deck image model override.' },
  { name: 'OPENROUTER_REASONING_EFFORT', scope: 'server', need: 'optional', secret: false, note: 'low | medium | high. Default medium.' },
  { name: 'OPENROUTER_SEARCH_ENGINE', scope: 'server', need: 'optional', secret: false, note: 'native | exa. Default native.' },
  { name: 'OPENROUTER_SEARCH_MAX_RESULTS', scope: 'server', need: 'optional', secret: false, note: 'Integer. Default 8.' },
  { name: 'OPENROUTER_SEARCH_TIER', scope: 'server', need: 'optional', secret: false, note: 'off disables web search.' },
  { name: 'OPENROUTER_IMAGE_TIER', scope: 'server', need: 'optional', secret: false, note: 'off disables deck image generation.' },
  { name: 'OPENROUTER_IMAGE_PALETTE', scope: 'server', need: 'optional', secret: false, note: 'Palette weight 0..1. Default 0.7.' },
  { name: 'OPENROUTER_VISUAL_REVIEW', scope: 'server', need: 'optional', secret: false, note: 'off disables the vision QC pass.' },
  { name: 'LAYOUT_ENGINE', scope: 'server', need: 'optional', secret: false, note: 'code | browser. Default code.' },

  // ── Generation policy: the switches that make spending possible at all. ───
  {
    name: 'LESSON_GENERATOR', scope: 'server', need: 'optional', secret: false,
    note: 'local | cloud | fixture. Defaults to local. cloud is refused unless the two '
      + 'switches below name the stages it needs.',
  },
  {
    name: 'ALLOW_EXTERNAL_PROVIDERS', scope: 'server', need: 'optional', secret: false,
    note: 'Must be exactly "true" before any paid provider can be constructed. Unset means '
      + 'no external spend is reachable.',
  },
  {
    name: 'EXTERNAL_PROVIDERS', scope: 'server', need: 'optional', secret: false,
    note: 'Comma-separated stage names (plan, image, speech, motion) allowed to use a paid '
      + 'API. Both switches are required together; there is no silent fallback.',
  },

  // ── Cloud lesson engine (Gemini). Reached only on an opted-in stage. ──────
  {
    name: 'GEMINI_API_KEY', scope: 'server', need: 'path', secret: true,
    when: 'CLOUD_LESSON_GEMINI_BACKEND=aistudio, which is the default when this key is set',
    shape: /^AIza[0-9A-Za-z_-]{30,}$/,
    note: 'AI Studio key. Declared twice in .env.example; the later line wins.',
  },
  {
    name: 'GOOGLE_VERTEX_API_KEY', scope: 'server', need: 'path', secret: true,
    when: 'CLOUD_LESSON_GEMINI_BACKEND=vertex',
    shape: /^AQ\.[A-Za-z0-9_-]{10,}$/,
    note: 'Vertex express-mode key. Used when GEMINI_API_KEY is absent.',
  },
  {
    name: 'CLOUD_LESSON_GEMINI_BACKEND', scope: 'server', need: 'optional', secret: false,
    note: 'aistudio | vertex. Inferred from which key is present when unset.',
  },
  { name: 'CLOUD_LESSON_GEMINI_CONCURRENCY', scope: 'server', need: 'optional', secret: false, note: 'Integer. Default 8.' },
  { name: 'CLOUD_LESSON_IMAGE_MODEL', scope: 'server', need: 'optional', secret: false, note: 'Gemini image model override.' },
  { name: 'CLOUD_LESSON_TTS_MODEL', scope: 'server', need: 'optional', secret: false, note: 'Gemini TTS model override.' },
  { name: 'CLOUD_LESSON_TTS_VOICE', scope: 'server', need: 'optional', secret: false, note: 'Voice name. Default Kore.' },
  { name: 'GEMINI_TTS_VOICE', scope: 'server', need: 'optional', secret: false, note: 'Older alias for CLOUD_LESSON_TTS_VOICE.' },
  {
    name: 'CLOUD_LESSON_MODEL_<SKILL>', scope: 'server', need: 'optional', secret: false,
    note: 'Per-skill model override whose name is built at runtime from the skill slug. '
      + 'Correctly absent from .env.example because the name is dynamic.',
  },

  // ── Motion (Higgsfield). Worker-only: no web process constructs it. ───────
  {
    name: 'HF_CREDENTIALS', scope: 'worker', need: 'path', secret: true,
    when: 'EXTERNAL_PROVIDERS names motion and scripts/cloud-media-worker.mts runs',
    shape: /^[^\s:]+:[^\s:]+$/,
    note: 'KEY_ID:KEY_SECRET in one value. HF_KEY, HIGGSFIELD, or HF_API_KEY_ID plus '
      + 'HF_API_KEY_SECRET are accepted alternatives. Declared twice in .env.example.',
  },
  { name: 'HF_KEY', scope: 'worker', need: 'optional', secret: true, note: 'Alternative spelling of HF_CREDENTIALS.' },
  { name: 'HIGGSFIELD', scope: 'worker', need: 'optional', secret: true, note: 'Alternative spelling of HF_CREDENTIALS.' },
  { name: 'HF_API_KEY_ID', scope: 'worker', need: 'optional', secret: true, note: 'Paired with HF_API_KEY_SECRET.' },
  { name: 'HF_API_KEY_SECRET', scope: 'worker', need: 'optional', secret: true, note: 'Paired with HF_API_KEY_ID.' },
  {
    name: 'CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND', scope: 'worker', need: 'optional', secret: false,
    note: 'Cost basis for motion. Default 0.035, which is an estimate and not a measurement.',
  },

  // ── Self-hosted services: the production default, all loopback. ──────────
  { name: 'LOCAL_VIDEO_AGENT_URL', scope: 'server', need: 'optional', secret: false, note: 'Planner service. Default http://127.0.0.1:18080.' },
  { name: 'LOCAL_VIDEO_TTS_URL', scope: 'server', need: 'optional', secret: false, note: 'Indic Parler-TTS. Default http://127.0.0.1:18081.' },
  { name: 'LOCAL_VIDEO_TRANSLATION_URL', scope: 'server', need: 'optional', secret: false, note: 'IndicTrans2. Default http://127.0.0.1:18082.' },
  { name: 'LOCAL_VIDEO_COMFY_URL', scope: 'server', need: 'optional', secret: false, note: 'ComfyUI. Default http://127.0.0.1:8188.' },
  { name: 'LOCAL_VIDEO_WORKER_URL', scope: 'server', need: 'optional', secret: false, note: 'Media worker control plane. Default http://127.0.0.1:8090.' },

  // ── Local binaries and assets. ───────────────────────────────────────────
  { name: 'CLOUD_LESSON_PYTHON', scope: 'server', need: 'optional', secret: false, note: 'Interpreter for the compositor. Default python.' },
  { name: 'CLOUD_LESSON_FFMPEG', scope: 'server', need: 'optional', secret: false, note: 'Default ffmpeg.' },
  { name: 'CLOUD_LESSON_FFPROBE', scope: 'server', need: 'optional', secret: false, note: 'Default ffprobe. Needed for the 40-second duration check.' },
  { name: 'CLOUD_LESSON_FONTS_DIR', scope: 'server', need: 'optional', secret: false, note: 'Default ops/cloud/fonts. Must hold a Kannada-capable face.' },
  { name: 'CLOUD_LESSON_MUSIC_DIR', scope: 'server', need: 'optional', secret: false, note: 'Background music directory. Unset means none.' },
  {
    name: 'CLOUD_LESSON_PROVIDER_MEDIA_HOSTS', scope: 'server', need: 'optional', secret: false,
    note: 'Allow-list of hosts a provider may return media from. Default higgsfield.ai, '
      + 'higgs.ai, cloudfront.net. Narrowing it is a security control, not a preference.',
  },

  // ── Declared but unread. Listed so nobody fills them in expecting effect. ─
  {
    name: 'GENAI_API_KEY', scope: 'server', need: 'unwired', secret: true,
    shape: /^AIza[0-9A-Za-z_-]{30,}$/,
    note: 'Reserved for the pgvector RAG path, which is not wired. No code reads it.',
  },
  { name: 'GOOGLE_CLOUD_PROJECT', scope: 'server', need: 'unwired', secret: false, note: 'Reserved for the unwired RAG path.' },
  { name: 'GOOGLE_CLOUD_LOCATION', scope: 'server', need: 'unwired', secret: false, note: 'Reserved for the unwired RAG path. Default us-central1.' },
  { name: 'GENAI_EMBED_MODEL', scope: 'server', need: 'unwired', secret: false, note: 'Reserved for the unwired RAG path.' },

  // ── Tooling. ─────────────────────────────────────────────────────────────
  {
    name: 'LUMINA_TEST_SEAM', scope: 'tooling', need: 'optional', secret: false,
    note: 'Set to 1 by test scripts only. It opens provider injection, so a serving process '
      + 'that sets it could bypass the paid-provider policy. It must never appear in a '
      + 'deployed environment.',
  },
  { name: 'NODE_ENV', scope: 'tooling', need: 'optional', secret: false, note: 'Set by Next.js and the test runner. Never set it by hand.' },
];

/** Worker-process variables, read by ops/runpod/*.py and the media worker. */
export const WORKER_VARS: EnvVar[] = [
  {
    name: 'SUPABASE_URL', scope: 'worker', need: 'required', secret: false,
    shape: SUPABASE_ORIGIN,
    note: 'Same origin as NEXT_PUBLIC_SUPABASE_URL; the worker has no NEXT_PUBLIC_ namespace. '
      + 'Also the anchor of its media allow-list. It appears in the web .env.example as a '
      + 'documented cross-reference for the Pod; the web app itself never reads it.',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY', scope: 'worker', need: 'required', secret: true,
    shape: SUPABASE_SECRET,
    note: 'The worker claims jobs and writes assets with it. Keep it on the GPU host only.',
  },
];

export function byScope(vars: EnvVar[], scope: Scope): EnvVar[] {
  return vars.filter((v) => v.scope === scope);
}

/** Variables whose absence stops a default, self-hosted deployment working. */
export function requiredForDefaultPath(): EnvVar[] {
  return ENV_VARS.filter((v) => v.need === 'required');
}

/** Names only, for a report that must not carry values. */
export function namesOf(vars: EnvVar[]): string[] {
  return vars.map((v) => v.name);
}
