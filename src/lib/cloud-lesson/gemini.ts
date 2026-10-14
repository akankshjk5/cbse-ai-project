import 'server-only';

import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';

import { serverEnv } from '@/lib/env';

import { type CostMeter, type GeminiUsage, priceGeminiUsage } from './pricing';
import { type CloudLessonSkill, type PromptValues, renderCloudLessonPrompt } from './skills';

/**
 * The cloud lesson engine's one door to Gemini — AI Studio (a Gemini API key)
 * or Vertex AI (an express-mode key), chosen by `cloudLessonGeminiBackend`.
 *
 * Three kinds of call, all through `GeminiTransport` so tests can replace the
 * network with a fake:
 *
 *  - `generateStructured` — a skill's system prompt plus a user prompt, JSON
 *    out, validated with Zod. A schema failure is sent back to Gemini as a
 *    correction in the same conversation, at most `maxAttempts` times; after
 *    that the call throws and the job fails with the reason, rather than a bad
 *    answer reaching a lesson.
 *  - `generateSpeech` — one sentence of narration, raw PCM out.
 *  - `generateImage` — one keyframe, image bytes out (used by the image worker).
 *
 * Every call is priced from Gemini's usage metadata into the caller's
 * CostMeter, and every call holds one slot of a process-wide limiter so a
 * burst of lessons cannot exceed the Gemini quota all at once.
 */

// ── Transport ────────────────────────────────────────────────────────────────

/** The request shape we send — a subset of the SDK's GenerateContentParameters. */
export interface GeminiRequest {
  model: string;
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[];
  config: Record<string, unknown>;
}

export type GeminiPart =
  | { text: string; speechMetadata?: { style?: string } }
  | { inlineData: { mimeType: string; data: string } };

/** The response fields we read. */
export interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
}

export interface GeminiTransport {
  generateContent(request: GeminiRequest): Promise<GeminiResponse>;
}

let defaultTransport: GeminiTransport | null = null;

/**
 * The real transport: the Google Gen AI SDK on the configured backend. The key
 * is always passed explicitly, so the SDK never falls back to whatever
 * GOOGLE_API_KEY / GOOGLE_CLOUD_PROJECT happen to be in the environment.
 */
export function geminiTransport(): GeminiTransport {
  if (!defaultTransport) {
    const vertexai = serverEnv.cloudLessonGeminiBackend === 'vertex';
    const client = new GoogleGenAI({ vertexai, apiKey: serverEnv.cloudLessonGeminiApiKey });
    defaultTransport = {
      generateContent: async (request) =>
        (await client.models.generateContent(request as Parameters<typeof client.models.generateContent>[0])) as GeminiResponse,
    };
  }
  return defaultTransport;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class GeminiCallError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'gemini_unavailable'
      | 'gemini_quota'
      | 'gemini_rejected'
      | 'gemini_blocked'
      | 'gemini_empty'
      | 'gemini_invalid_output',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiCallError';
  }
}

const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return TRANSIENT_STATUSES.has(status);
  // No status: a network fault, timeout or reset — worth one more try.
  return error instanceof Error && /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT|socket/i.test(error.message);
}

// ── Limiter ──────────────────────────────────────────────────────────────────

class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

let limiter: Limiter | null = null;
const geminiLimiter = () => (limiter ??= new Limiter(serverEnv.cloudLessonGeminiConcurrency));

// ── One call, with transient retries, pricing and timing ───────────────────

export interface CallOptions {
  transport?: GeminiTransport;
  meter?: CostMeter;
  /** Label for the cost record, e.g. the skill name or `tts`. */
  stage: string;
  /** Waits between transient retries; tests pass zeros. */
  retryDelaysMs?: number[];
  /**
   * Longest wait a 429's own "retry in Ns" may stretch a retry to. Default
   * 60 s; tests pass 0. A per-day quota is never waited on.
   */
  maxRetryWaitMs?: number;
}

/**
 * How long a 429 asks us to wait, from Google's RetryInfo detail
 * (`"retryDelay":"21s"`) or the message ("Please retry in 21.3s"). Null when
 * it does not say.
 */
export function retryAfterMs(error: unknown): number | null {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const match = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ?? text.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * True when a 429 is a quota that will not refill within a retry — a per-day
 * limit, or the free tier (whose limits are far below one lesson's needs).
 */
export function isHardQuota(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return statusOf(error) === 429 && /per_?day|PerDay|free_tier/i.test(text);
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 6_000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(request: GeminiRequest, options: CallOptions): Promise<GeminiResponse> {
  const transport = options.transport ?? geminiTransport();
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const started = Date.now();
    try {
      const response = await geminiLimiter().run(() => transport.generateContent(request));
      const priced = priceGeminiUsage(request.model, response.usageMetadata);
      options.meter?.add({ ...priced, stage: options.stage, model: request.model, latencyMs: Date.now() - started });
      const blocked = response.promptFeedback?.blockReason;
      if (blocked) {
        throw new GeminiCallError(`Gemini blocked the ${options.stage} request (${blocked}).`, 'gemini_blocked');
      }
      return response;
    } catch (error) {
      if (error instanceof GeminiCallError) throw error;
      lastError = error;
      if (!isTransient(error) || isHardQuota(error) || attempt === delays.length) break;
      // A 429 says how long its window is; retrying sooner just spends the retry.
      const asked = statusOf(error) === 429 ? retryAfterMs(error) : null;
      const cap = options.maxRetryWaitMs ?? 60_000;
      await sleep(Math.max(delays[attempt], asked === null ? 0 : Math.min(asked + 500, cap)));
    }
  }
  const status = statusOf(lastError);
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const freeTier = /free_tier/i.test(detail);
  throw new GeminiCallError(
    `Gemini ${request.model} failed for ${options.stage}${status ? ` (HTTP ${status})` : ''}: `
      + (freeTier ? 'the key is on the FREE tier — billing is not active on its Google project. ' : '')
      + detail.slice(0, 500),
    isHardQuota(lastError) ? 'gemini_quota'
      : status !== undefined && !TRANSIENT_STATUSES.has(status) ? 'gemini_rejected' : 'gemini_unavailable',
    status,
  );
}

function textOf(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('');
}

// ── Structured output ───────────────────────────────────────────────────────

/**
 * Zod → the JSON Schema Gemini's `responseJsonSchema` accepts. Refinements
 * (word counts, "no digits") cannot be expressed in JSON Schema; they are
 * enforced by the Zod parse afterwards and fed back as corrections.
 */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return geminiCompatible(json) as Record<string, unknown>;
}

/**
 * Rewrites the few JSON Schema keywords Zod emits that Gemini's
 * responseJsonSchema subset may not accept: `oneOf` (a discriminated union)
 * becomes the equivalent-for-generation `anyOf`, `const` becomes a one-value
 * `enum`, and `pattern` / `default` are dropped. Zod still validates the
 * answer exactly afterwards, so nothing is lost but a hint.
 */
function geminiCompatible(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(geminiCompatible);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'oneOf') out.anyOf = geminiCompatible(value);
    else if (key === 'const') out.enum = [value];
    else if (key === 'pattern' || key === 'default') continue;
    else out[key] = geminiCompatible(value);
  }
  return out;
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  return JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `- ${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('\n');
}

export interface StructuredOptions<T> extends Omit<CallOptions, 'stage'> {
  skill: CloudLessonSkill;
  /** Values for the skill's `{{placeholders}}`. */
  values: PromptValues;
  userPrompt: string;
  schema: z.ZodType<T>;
  /** Deterministic clean-up applied to the parsed JSON before validation. */
  normalize?: (output: unknown) => unknown;
  /** Total answers Gemini may give, including the first. Default 2. */
  maxAttempts?: number;
}

export interface StructuredResult<T> {
  data: T;
  /** Answers it took, 1 = first answer passed. */
  attempts: number;
}

/** The skill's thinking setting in the SDK's shape: a level for 3.x, a budget for 2.5. */
export function thinkingConfigFor(skill: Pick<CloudLessonSkill, 'thinkingLevel' | 'thinkingBudget'>) {
  if (skill.thinkingLevel) return { thinkingLevel: skill.thinkingLevel.toUpperCase() };
  if (skill.thinkingBudget !== null) return { thinkingBudget: skill.thinkingBudget };
  return null;
}

export async function generateStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const { skill } = options;
  const maxAttempts = Math.max(1, Math.min(4, options.maxAttempts ?? 2));
  const systemInstruction = renderCloudLessonPrompt(skill, options.values);
  let schemaJson: Record<string, unknown> | null = toGeminiSchema(options.schema);
  const contents: GeminiRequest['contents'] = [{ role: 'user', parts: [{ text: options.userPrompt }] }];
  let lastProblem = '';

  let thinkingConfig: Record<string, unknown> | null = thinkingConfigFor(skill);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const config: Record<string, unknown> = {
      systemInstruction,
      ...(skill.temperature !== null ? { temperature: skill.temperature } : {}),
      maxOutputTokens: skill.maxOutputTokens,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      responseMimeType: 'application/json',
      ...(schemaJson ? { responseJsonSchema: schemaJson } : {}),
    };
    let response: GeminiResponse;
    try {
      response = await call({ model: skill.modelId, contents, config }, { ...options, stage: skill.name });
    } catch (error) {
      const refused = error instanceof GeminiCallError && error.status === 400;
      // A thinking setting the model does not take (a level on a 2.5 model
      // after an env override, or `minimal` on a model without it) is a 400
      // on every attempt. Drop it once and let the model use its default.
      if (thinkingConfig && refused && /thinking/i.test(error.message)) {
        console.warn(`[cloud-lesson] ${skill.name}: ${skill.modelId} refused the thinking setting; using its default`);
        thinkingConfig = null;
        attempt -= 1;
        continue;
      }
      // A schema Gemini will not accept is also a 400 every time. Fall back to
      // plain JSON mode once; Zod still enforces the shape.
      // Some models reject a complex schema with only INVALID_ARGUMENT,
      // without naming the schema. Probe plain JSON once in that case too.
      if (schemaJson && refused && /schema|Request contains an invalid argument/i.test(error.message)) {
        console.warn(`[cloud-lesson] ${skill.name}: Gemini refused the response schema; retrying in plain JSON mode`);
        schemaJson = null;
        attempt -= 1;
        continue;
      }
      throw error;
    }

    const raw = textOf(response);
    const finish = response.candidates?.[0]?.finishReason;
    let parsed: unknown;
    try {
      if (!raw.trim()) throw new Error(`empty answer${finish ? ` (finish reason ${finish})` : ''}`);
      parsed = extractJson(raw);
    } catch (error) {
      lastProblem = `Your answer was not valid JSON (${error instanceof Error ? error.message : 'unparseable'}). `
        + 'Return one complete JSON object only.';
      contents.push({ role: 'model', parts: [{ text: raw || '(empty)' }] }, { role: 'user', parts: [{ text: lastProblem }] });
      continue;
    }

    const normalized = options.normalize ? options.normalize(parsed) : parsed;
    const result = options.schema.safeParse(normalized);
    if (result.success) return { data: result.data, attempts: attempt };

    lastProblem = describeIssues(result.error);
    contents.push(
      { role: 'model', parts: [{ text: raw }] },
      {
        role: 'user',
        parts: [{
          text: 'Your JSON failed validation. Correct every problem below and return the complete JSON again.\n'
            + lastProblem,
        }],
      },
    );
  }

  throw new GeminiCallError(
    `${skill.name} did not return a valid answer after ${maxAttempts} attempts:\n${lastProblem}`.slice(0, 2000),
    'gemini_invalid_output',
  );
}

// ── Speech ───────────────────────────────────────────────────────────────────

export type SpeechPace = 'natural' | 'brisk';

/**
 * How each pace is asked for. Gemini 3.x speech models read the text part
 * VERBATIM — a "Read this aloud like…" lead-in would be spoken — so the
 * direction travels in the part's `speechMetadata.style` instead, and the
 * text is the narration and nothing else.
 */
const PACE_STYLE: Record<SpeechPace, string> = {
  natural: 'A warm, clear teacher explaining to a class; calm, natural pace; friendly and confident',
  brisk: 'A clear, confident teacher; brisk but easy-to-follow pace; no long pauses',
};

const ACCENT: Record<string, string> = {
  'en-IN': '; neutral Indian English accent',
  'hi-IN': '; natural standard Hindi pronunciation',
  'kn-IN': '; natural standard Kannada pronunciation',
};

/** The style instruction for one pace and language. Exported for tests. */
/**
 * Who is speaking. `teacher` is every existing style's voice; `storyteller`
 * is the storybook style's — the same voice and pace limits, delivered as a
 * tale rather than an explanation.
 */
export type VoiceStyle = 'teacher' | 'storyteller';

const STORYTELLER_STYLE: Record<SpeechPace, string> = {
  natural: 'An engaging storyteller telling a true tale to a class; expressive and warm, with gentle emphasis on the key moment; clear, measured pace',
  brisk: 'An engaging storyteller; lively and expressive but clear and well paced; no long pauses',
};

export function speechStyle(pace: SpeechPace, languageCode: string, voiceStyle: VoiceStyle = 'teacher'): string {
  const base = voiceStyle === 'storyteller' ? STORYTELLER_STYLE[pace] : PACE_STYLE[pace];
  return `${base}${ACCENT[languageCode] ?? ''}`;
}

export interface SpeechOptions extends Omit<CallOptions, 'stage'> {
  text: string;
  languageCode: 'en-IN' | 'hi-IN' | 'kn-IN';
  pace: SpeechPace;
  model?: string;
  voice?: string;
  /** Default `teacher`. */
  voiceStyle?: VoiceStyle;
}

export interface SpeechResult {
  /** 16-bit signed little-endian mono PCM. */
  pcm: Int16Array;
  sampleRate: number;
}

/** Parses `audio/L16;codec=pcm;rate=24000` (Gemini's TTS output) or a WAV payload. */
export function decodeSpeechPayload(mimeType: string, base64: string): SpeechResult {
  const bytes = Buffer.from(base64, 'base64');
  if (/wav/i.test(mimeType) || bytes.toString('ascii', 0, 4) === 'RIFF') {
    // WAV: find fmt and data chunks.
    let offset = 12;
    let sampleRate = 24_000;
    let bits = 16;
    let channels = 1;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ') {
        channels = bytes.readUInt16LE(body + 2);
        sampleRate = bytes.readUInt32LE(body + 4);
        bits = bytes.readUInt16LE(body + 14);
      } else if (id === 'data') {
        if (bits !== 16 || channels !== 1) {
          throw new GeminiCallError(`Unsupported speech format: ${channels} ch, ${bits}-bit`, 'gemini_invalid_output');
        }
        const data = bytes.subarray(body, Math.min(bytes.length, body + size));
        return { pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1))), sampleRate };
      }
      offset = body + size + (size % 2);
    }
    throw new GeminiCallError('Speech WAV has no data chunk', 'gemini_invalid_output');
  }
  if (!/l16|pcm/i.test(mimeType)) {
    throw new GeminiCallError(`Unexpected speech MIME type ${mimeType}`, 'gemini_invalid_output');
  }
  const rate = Number(mimeType.match(/rate=(\d+)/i)?.[1] ?? 24_000);
  const even = bytes.length & ~1;
  const aligned = Buffer.alloc(even);
  bytes.copy(aligned, 0, 0, even);
  return { pcm: new Int16Array(aligned.buffer, aligned.byteOffset, even / 2), sampleRate: rate };
}

export async function generateSpeech(options: SpeechOptions): Promise<SpeechResult> {
  const text = options.text.trim();
  if (!text) throw new GeminiCallError('Nothing to speak', 'gemini_invalid_output');
  const model = options.model ?? serverEnv.cloudLessonTtsModel;
  const voice = options.voice ?? serverEnv.cloudLessonTtsVoice;
  const request = (part: GeminiPart): GeminiRequest => ({
    model,
    contents: [{ role: 'user', parts: [part] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  let response: GeminiResponse;
  try {
    response = await call(
      request({ text, speechMetadata: { style: speechStyle(options.pace, options.languageCode, options.voiceStyle) } }),
      { ...options, stage: 'tts' },
    );
  } catch (error) {
    // An older speech model (an env override back to 2.5) may not know the
    // field. Say the narration plainly rather than fail the lesson.
    if (!(error instanceof GeminiCallError && error.status === 400 && /speech_?metadata|unknown name/i.test(error.message))) {
      throw error;
    }
    console.warn(`[cloud-lesson] tts: ${model} refused speechMetadata; speaking without a style`);
    response = await call(request({ text }), { ...options, stage: 'tts' });
  }
  const audio = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!audio?.data) {
    throw new GeminiCallError(
      `Gemini returned no audio${response.candidates?.[0]?.finishReason ? ` (${response.candidates[0].finishReason})` : ''}`,
      'gemini_empty',
    );
  }
  return decodeSpeechPayload(audio.mimeType ?? 'audio/L16;codec=pcm;rate=24000', audio.data);
}

// ── Image (used by the image worker) ─────────────────────────────────────────

export interface ImageOptions extends Omit<CallOptions, 'stage'> {
  model: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: '1K' | '2K' | '4K';
  /** Earlier keyframe of the same lesson, passed so the style stays consistent. */
  styleReference?: { mimeType: string; data: Buffer };
  /** What to take from the reference. Defaults to the photographic wording the existing styles use. */
  referenceInstruction?: string;
}

export async function generateImage(options: ImageOptions): Promise<{ mimeType: string; data: Buffer }> {
  const parts: GeminiPart[] = [];
  if (options.styleReference) {
    parts.push(
      { inlineData: { mimeType: options.styleReference.mimeType, data: options.styleReference.data.toString('base64') } },
      { text: options.referenceInstruction ?? 'Match the photographic style, colour palette and lighting of the reference photograph above, but show a new subject:' },
    );
  }
  parts.push({ text: options.prompt });
  const response = await call({
    model: options.model,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: options.aspectRatio ?? '16:9', ...(options.imageSize ? { imageSize: options.imageSize } : {}) },
    },
  }, { ...options, stage: 'image' });
  const image = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!image?.data) {
    throw new GeminiCallError(
      `Gemini returned no image${response.candidates?.[0]?.finishReason ? ` (${response.candidates[0].finishReason})` : ''}`,
      'gemini_empty',
    );
  }
  return { mimeType: image.mimeType ?? 'image/png', data: Buffer.from(image.data, 'base64') };
}

/** Image input for a structured call (the keyframe checker). */
export function imagePart(mimeType: string, data: Buffer): GeminiPart {
  return { inlineData: { mimeType, data: data.toString('base64') } };
}

/**
 * `generateStructured` with an image attached to the user turn — the keyframe
 * checker's call. Same validation and retry rules.
 */
export async function generateStructuredWithImage<T>(
  options: StructuredOptions<T> & { image: { mimeType: string; data: Buffer } },
): Promise<StructuredResult<T>> {
  const transport = options.transport ?? geminiTransport();
  const withImage: GeminiTransport = {
    generateContent: (request) => {
      const [first, ...rest] = request.contents;
      return transport.generateContent({
        ...request,
        contents: [{ ...first, parts: [imagePart(options.image.mimeType, options.image.data), ...first.parts] }, ...rest],
      });
    },
  };
  return generateStructured({ ...options, transport: withImage });
}
