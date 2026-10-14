/**
 * Environment access. Every process.env read in the app goes through here.
 *
 * Rule: a missing variable throws at first use with the variable's name in the
 * message. We do not fall back to empty strings — a Supabase client built from
 * "" fails much later with an unrelated network error.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing environment variable ${name}. Add it to .env (see .env.example) ` +
        `or pull it with \`vercel env pull\`.`,
    );
  }
  return value;
}

/** Safe in the browser: both values are publishable by design. */
export const publicEnv = {
  get supabaseUrl() {
    return required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabaseAnonKey() {
    return required(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
  },
  get siteUrl() {
    return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  },
};

/**
 * Server-only. Reading any of these from a Client Component is a bug — the
 * bundler would either inline the secret or hand you `undefined`.
 */
export const serverEnv = {
  get localVideoAgentUrl() {
    return process.env.LOCAL_VIDEO_AGENT_URL ?? 'http://127.0.0.1:18080';
  },
  get localVideoTtsUrl() {
    return process.env.LOCAL_VIDEO_TTS_URL ?? 'http://127.0.0.1:18081';
  },
  get localVideoTranslationUrl() {
    return process.env.LOCAL_VIDEO_TRANSLATION_URL ?? 'http://127.0.0.1:18082';
  },
  get localVideoComfyUrl() {
    return process.env.LOCAL_VIDEO_COMFY_URL ?? 'http://127.0.0.1:8188';
  },
  get localVideoWorkerUrl() {
    return process.env.LOCAL_VIDEO_WORKER_URL ?? 'http://127.0.0.1:8090';
  },
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
  },
  get openRouterApiKey() {
    return required('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);
  },
  /**
   * Fallback for a skill that declares no `model:` of its own.
   *
   * Every specialist does declare one, so this is a safety net rather than a
   * default anyone should be relying on — but it still has to reason, because
   * the pipeline asks for reasoning on every call.
   */
  get openRouterModel() {
    return process.env.OPENROUTER_MODEL ?? 'z-ai/glm-5.3-flash';
  },
  /**
   * Vision model for the style-reference → StyleSpec conversion. It is the only
   * call that sees the reference image, and it must return JSON and nothing
   * else, so a cheap, fast, strictly-instructable model is the right tool.
   */
  get openRouterVisionModel() {
    return process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-3.6-flash';
  },
  /** Image generation. Slug lives in env because providers retire models. */
  get openRouterImageModel() {
    return process.env.OPENROUTER_IMAGE_MODEL ?? 'google/gemini-3.1-flash-lite-image';
  },
  /**
   * Per-skill model override, e.g. `OPENROUTER_MODEL_SLIDE_DESIGNER`.
   *
   * Each specialist names its model in its Markdown frontmatter, which keeps
   * the choice next to the prompt it belongs to. This is the escape hatch: a
   * provider retires a slug, or one stage needs to move to a bigger model, and
   * neither should require editing a skill file to fix in production.
   */
  modelForSkill(slug: string): string | undefined {
    const key = `OPENROUTER_MODEL_${slug.toUpperCase().replace(/-/g, '_')}`;
    const value = process.env[key];
    return value?.trim() ? value.trim() : undefined;
  },
  /**
   * How hard every specialist is allowed to think, unless it asks for
   * something else. The pipeline is a chain of judgements — which facts matter,
   * what a slide should say, where a picture helps — and a model that answers
   * those without reasoning produces a deck that looks right and says nothing.
   *
   * `minimal` turns reasoning off entirely, which also empties the terminal
   * trace. Use it to compare cost, not to run builds you intend to debug.
   */
  get reasoningEffort(): 'minimal' | 'low' | 'medium' | 'high' {
    const value = (process.env.OPENROUTER_REASONING_EFFORT ?? 'medium').toLowerCase();
    return value === 'minimal' || value === 'low' || value === 'high' ? value : 'medium';
  },
  /**
   * Search engine for the research stage.
   *
   * `native` asks the provider to use its own grounding — on a Gemini model
   * that is Google Search, which is the point — and OpenRouter falls back to
   * its own engine for providers that have none. No separate search API key:
   * the search is billed through the same OpenRouter call as the reasoning.
   */
  get webSearchEngine(): 'native' | 'exa' | 'firecrawl' | 'parallel' | 'perplexity' {
    const value = (process.env.OPENROUTER_SEARCH_ENGINE ?? 'native').toLowerCase();
    return value === 'exa' ||
      value === 'firecrawl' ||
      value === 'parallel' ||
      value === 'perplexity'
      ? value
      : 'native';
  },
  get webSearchMaxResults(): number {
    const parsed = Number(process.env.OPENROUTER_SEARCH_MAX_RESULTS ?? '8');
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(20, Math.round(parsed)) : 8;
  },
  /**
   * `off` forbids the researcher from reaching the web. A deck then relies on
   * supplied documents and the model's own knowledge, which is the right
   * trade for an offline or cost-capped environment and the wrong one for
   * anything where the facts have to be current.
   */
  get webSearchEnabled() {
    return (process.env.OPENROUTER_SEARCH_TIER ?? 'on').toLowerCase() !== 'off';
  },
  /**
   * How far a generated image is pulled into the deck's palette, 0-1.
   *
   * Image models honour a palette until the subject has a conventional colour,
   * and then a pond is green no matter what the prompt forbids. One stray hue
   * across twelve slides is the thing a viewer notices first, so
   * `Agents/palette.ts` maps brightness through the deck's own colours and
   * blends the result back at this strength.
   *
   * 0.7 removes stray hues while leaving form, shading and detail intact. 0
   * turns the pass off and gives raw model output.
   */
  get imagePaletteStrength(): number {
    const parsed = Number(process.env.OPENROUTER_IMAGE_PALETTE ?? '0.7');
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.7;
  },
  /**
   * `off` skips the visual review — the one stage that renders the deck and
   * looks at it.
   *
   * It is worth its cost (one vision call, about a third of a cent) because it
   * is the only check in the pipeline that can fail for a reason nobody wrote a
   * rule for: a title on someone's face, one illustration in a different style
   * from the rest, a slide that is simply emptier than its neighbours. Turn it
   * off for offline work or to shave the last cent, not to go faster.
   */
  get visualReviewEnabled() {
    return (process.env.OPENROUTER_VISUAL_REVIEW ?? 'on').toLowerCase() !== 'off';
  },
  /** `off` disables illustration generation entirely; anything else enables it. */
  get imagesEnabled() {
    return (process.env.OPENROUTER_IMAGE_TIER ?? 'on').toLowerCase() !== 'off';
  },
  /**
   * `browser`: geometry and type sizing come from `Agents/pptx/browser-layout.ts`
   * rendering the real `SlideCanvas` in a headless Chromium and measuring it.
   * `code` (default while the migration is in progress): the original
   * `applyLayouts`/`growTextBoxes`/`fitToCanvas`/`fitTypeToBoxes`/
   * `compactTitleBand` sequence in `Agents/manager.ts`, kept as a rollback
   * path until the browser path has run cleanly on real decks. See the
   * migration plan in `Agents/pptx/browser-layout.ts`'s header comment.
   */
  get layoutEngine(): 'code' | 'browser' {
    return (process.env.LAYOUT_ENGINE ?? 'code').toLowerCase() === 'browser' ? 'browser' : 'code';
  },
  get genaiApiKey() {
    return required('GENAI_API_KEY', process.env.GENAI_API_KEY);
  },
  get googleCloudProject() {
    return required('GOOGLE_CLOUD_PROJECT', process.env.GOOGLE_CLOUD_PROJECT);
  },
  get googleCloudLocation() {
    return process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  },
  get embedModel() {
    return process.env.GENAI_EMBED_MODEL ?? 'gemini-embedding-001';
  },
  /**
   * Clerk's SDK reads CLERK_SECRET_KEY itself; this getter exists for code that
   * calls the Backend API directly. Never expose it to the browser.
   */
  get clerkSecretKey() {
    return required('CLERK_SECRET_KEY', process.env.CLERK_SECRET_KEY);
  },

  // ── Cloud lesson engine (Gemini + Higgsfield) ─────────────────────────────
  // Read only by src/lib/cloud-lesson/*. Nothing in the deck pipeline or the
  // RunPod lesson engine touches these.

  /**
   * Per-skill model override for the cloud lesson skills, e.g.
   * `CLOUD_LESSON_MODEL_CLOUD_LESSON_SCENE_DIRECTOR=gemini/gemini-3.8-flash`.
   * Separate from `OPENROUTER_MODEL_<SKILL>`: these skills call Gemini
   * directly, never through OpenRouter.
   */
  cloudLessonModelForSkill(slug: string): string | undefined {
    const key = `CLOUD_LESSON_MODEL_${slug.toUpperCase().replace(/-/g, '_')}`;
    const value = process.env[key];
    return value?.trim() ? value.trim() : undefined;
  },
  /**
   * Which Gemini service the cloud engine calls. Same models either way:
   *  - `aistudio` — a Gemini API key from aistudio.google.com (GEMINI_API_KEY,
   *    starts `AIza`). Needs billing on the key's project for real traffic.
   *  - `vertex` — a Vertex AI express-mode key (GOOGLE_VERTEX_API_KEY, starts
   *    `AQ.`). Needs the Vertex AI API enabled on its project.
   * CLOUD_LESSON_GEMINI_BACKEND picks one explicitly; otherwise AI Studio is
   * used when GEMINI_API_KEY is set, and Vertex when only the Vertex key is.
   */
  get cloudLessonGeminiBackend(): 'aistudio' | 'vertex' {
    const explicit = process.env.CLOUD_LESSON_GEMINI_BACKEND?.trim().toLowerCase();
    if (explicit === 'aistudio' || explicit === 'vertex') return explicit;
    if (process.env.GEMINI_API_KEY?.trim()) return 'aistudio';
    return 'vertex';
  },
  /** The key for `cloudLessonGeminiBackend`. Throws by name when it is missing. */
  get cloudLessonGeminiApiKey() {
    return this.cloudLessonGeminiBackend === 'aistudio'
      ? required('GEMINI_API_KEY', process.env.GEMINI_API_KEY)
      : required('GOOGLE_VERTEX_API_KEY', process.env.GOOGLE_VERTEX_API_KEY);
  },
  /**
   * Gemini speech model for the cloud lesson engine. Deliberately does NOT
   * fall back to GEMINI_TTS_MODEL: that belongs to the other engine, and its
   * Gemini 2.5 value is closed to new Gemini accounts. Use
   * CLOUD_LESSON_TTS_MODEL to change this one.
   */
  get cloudLessonTtsModel() {
    return process.env.CLOUD_LESSON_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts';
  },
  /**
   * Gemini image model for the cloud lesson keyframes. Nano Banana 2.1 costs
   * the same per 1K image as 3.1 Flash-Lite Image ($0.0336) and is built to
   * follow a reference image, which is how scenes 2-8 keep scene 1's look.
   */
  get cloudLessonImageModel() {
    return process.env.CLOUD_LESSON_IMAGE_MODEL?.trim() || 'gemini-nano-banana-2.1';
  },
  get cloudLessonHiggsfieldCredentials() {
    const value = process.env.HF_CREDENTIALS?.trim() || process.env.HF_KEY?.trim()
      || (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET
        ? `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}` : undefined)
      || process.env.HIGGSFIELD?.trim();
    const credentials = required('HF_CREDENTIALS (KEY_ID:KEY_SECRET)', value);
    if (!/^[^\s:]+:[^\s:]+$/.test(credentials)) throw new Error('HF_CREDENTIALS must be KEY_ID:KEY_SECRET.');
    return credentials;
  },
  /** Estimate only; account invoices remain authoritative. Recheck promotional rates. */
  get cloudLessonHiggsfieldUsdPerSecond() {
    const rate = Number(process.env.CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND ?? '0.035');
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND.');
    return rate;
  },
  get cloudLessonPython() { return process.env.CLOUD_LESSON_PYTHON?.trim() || 'python'; },
  get cloudLessonFfmpeg() { return process.env.CLOUD_LESSON_FFMPEG?.trim() || 'ffmpeg'; },
  get cloudLessonFfprobe() { return process.env.CLOUD_LESSON_FFPROBE?.trim() || 'ffprobe'; },
  get cloudLessonFontsDir() { return process.env.CLOUD_LESSON_FONTS_DIR?.trim() || 'ops/cloud/fonts'; },
  /** Optional folder of licensed .wav/.m4a background tracks for storybook lessons. Unset = no music. */
  get cloudLessonMusicDir() { return process.env.CLOUD_LESSON_MUSIC_DIR?.trim() || undefined; },
  /** Local encoding tools need runtime paths and locale, but no API credentials. */
  get cloudLessonSubprocessEnv(): NodeJS.ProcessEnv {
    const values: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
      'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'PYTHONPATH']) {
      const value = process.env[name];
      if (value !== undefined) values[name] = value;
    }
    return values;
  },
  get cloudLessonProviderMediaHosts() {
    return (process.env.CLOUD_LESSON_PROVIDER_MEDIA_HOSTS || 'higgsfield.ai,higgs.ai,cloudfront.net')
      .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  },
  /** Prebuilt Gemini voice for narration, e.g. Kore. */
  get cloudLessonTtsVoice() {
    return process.env.CLOUD_LESSON_TTS_VOICE?.trim() || process.env.GEMINI_TTS_VOICE?.trim() || 'Kore';
  },
  /**
   * Gemini calls one process may have in flight at once, across all lessons.
   * Keeps a burst of teachers from tripping Gemini's per-minute quota.
   */
  get cloudLessonGeminiConcurrency(): number {
    const parsed = Number(process.env.CLOUD_LESSON_GEMINI_CONCURRENCY ?? '8');
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 8;
  },
};

/**
 * Embedding width, locked to the `vector(1536)` column in migration 0500.
 * Changing this without a re-typing migration + full re-embed silently corrupts
 * retrieval, so it is a constant here rather than an env var.
 */
export const EMBEDDING_DIMENSIONS = 1536;
