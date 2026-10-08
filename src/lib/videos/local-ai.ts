import 'server-only';

import { z } from 'zod';

import { serverEnv } from '@/lib/env';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

interface WorkerHealth {
  status?: string;
  scope?: { kind?: string; ownerId?: string; projectIds?: string[] };
}

function localServiceUrl(name: string, raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must use a loopback HTTP address; connect to RunPod with an SSH tunnel.`);
  }
  return url;
}

/** Reject a new lesson before reserving a row when the paid Pod is offline. */
export async function assertLocalVideoServicesReady(ownerId: string): Promise<void> {
  const services = [
    ['planner', 'LOCAL_VIDEO_AGENT_URL', serverEnv.localVideoAgentUrl, '/health'],
    ['translation', 'LOCAL_VIDEO_TRANSLATION_URL', serverEnv.localVideoTranslationUrl, '/health'],
    ['voice', 'LOCAL_VIDEO_TTS_URL', serverEnv.localVideoTtsUrl, '/health'],
    ['animation', 'LOCAL_VIDEO_COMFY_URL', serverEnv.localVideoComfyUrl, '/system_stats'],
    ['media worker', 'LOCAL_VIDEO_WORKER_URL', serverEnv.localVideoWorkerUrl, '/health'],
  ] as const;
  const results = await Promise.all(services.map(async ([label, name, raw, path]) => {
    try {
      const response = await fetch(new URL(path, localServiceUrl(name, raw)), {
        cache: 'no-store',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return label;
      if (label === 'media worker') {
        const body = await response.json() as WorkerHealth;
        const ready = (body.status === 'idle' || body.status === 'processing')
          && body.scope?.kind === 'owner' && body.scope.ownerId === ownerId;
        return ready ? null : label;
      }
      return null;
    } catch {
      return label;
    }
  }));
  const unavailable = results.filter((label) => label !== null);
  if (unavailable.length) {
    throw new Error(`Video backend is not ready (${unavailable.join(', ')}). Start the RunPod services before generating.`);
  }
}

/** A running Pod is not enough: its worker must be allowed to claim this job. */
export async function canWorkerProcessLesson(ownerId: string, projectId: string): Promise<boolean> {
  try {
    const baseUrl = localServiceUrl('LOCAL_VIDEO_WORKER_URL', serverEnv.localVideoWorkerUrl);
    const response = await fetch(new URL('/health', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as WorkerHealth;
    if (body.status !== 'idle' && body.status !== 'processing') return false;
    return (body.scope?.kind === 'owner' && body.scope.ownerId === ownerId)
      || (body.scope?.kind === 'projects' && body.scope.projectIds?.includes(projectId) === true);
  } catch {
    return false;
  }
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate);
}

export async function generateLocalStructured<T>(options: {
  stage: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  maxValidationAttempts?: number;
  /** Deterministic clean-up applied to every model output before validation. */
  normalize?: (output: unknown) => unknown;
  /** Last resort after every attempt failed: repair the final output in code. */
  fallback?: (lastOutput: unknown) => unknown;
}): Promise<T> {
  const baseUrl = localServiceUrl('LOCAL_VIDEO_AGENT_URL', serverEnv.localVideoAgentUrl);
  const jsonSchema = z.toJSONSchema(options.schema as z.ZodType<unknown>, {
    io: 'input',
    unrepresentable: 'any',
  });
  const attempts = Math.max(1, Math.min(3, options.maxValidationAttempts ?? 2));
  let correction = '';
  let lastError: z.ZodError | undefined;
  let lastOutput: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(new URL('/structured', baseUrl), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: options.stage,
        systemPrompt: options.systemPrompt,
        userPrompt: `${options.userPrompt}${correction}`,
        jsonSchema,
        maxNewTokens: options.stage === 'video-narration-duration-editor' ? 1_400 : 4_000,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });

    const body = await response.json().catch(() => null) as {
      output?: unknown;
      raw?: string;
      error?: string;
    } | null;
    // A 500 from the planner is almost always unparseable JSON from the model;
    // treat it like an invalid answer and ask again instead of failing.
    let rawOutput: unknown;
    try {
      if (!response.ok) {
        throw new Error(body?.error || `Local ${options.stage} service returned HTTP ${response.status}.`);
      }
      rawOutput = body?.output ?? (body?.raw ? extractJson(body.raw) : undefined);
      if (rawOutput === undefined) throw new Error(`Local ${options.stage} returned no structured output.`);
    } catch (error) {
      if (attempt >= attempts || (response.status !== 500 && response.ok === false)) throw error;
      correction = '\n\nYour previous answer was not valid JSON. Return one complete JSON object only.';
      continue;
    }
    const output = options.normalize ? options.normalize(rawOutput) : rawOutput;
    lastOutput = output;
    const parsed = options.schema.safeParse(output);
    if (parsed.success) return parsed.data;
    lastError = parsed.error;
    correction = `\n\nYour previous JSON failed validation. Correct every listed problem and return the complete JSON again.\nValidation problems:\n${parsed.error.issues
      .slice(0, 12)
      .map((issue) => `- ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n')}${options.stage === 'video-lesson-director'
      ? '\nRewrite the entire visual plan from scratch using physical props only. Do not repeat any invalid scene descriptions.'
      : `\nPrevious JSON:\n${JSON.stringify(output)}`}`;
  }

  if (options.fallback && lastOutput !== undefined) {
    const repaired = options.schema.safeParse(options.fallback(lastOutput));
    if (repaired.success) {
      console.warn(`[local-ai] ${options.stage} used the deterministic fallback after ${attempts} attempts`);
      return repaired.data;
    }
  }
  throw lastError ?? new Error(`Local ${options.stage} output failed validation.`);
}

export async function synthesizeLocalSpeech(input: {
  transcript: string;
  languageCode: string;
  pace: 'natural' | 'brisk';
  sceneTranscripts?: string[];
  sceneDurationSeconds?: number;
}): Promise<{ wave: Buffer; model: string; voice: string }> {
  const baseUrl = localServiceUrl('LOCAL_VIDEO_TTS_URL', serverEnv.localVideoTtsUrl);
  const response = await fetch(new URL('/synthesize', baseUrl), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Local narration service returned HTTP ${response.status}.`);
  }
  return {
    wave: Buffer.from(await response.arrayBuffer()),
    model: response.headers.get('x-lumina-model') || 'ai4bharat/indic-parler-tts',
    voice: response.headers.get('x-lumina-voice') || 'local-indic-educator',
  };
}

export async function translateLocalTexts(input: {
  texts: string[];
  languageCode: string;
}): Promise<string[]> {
  const baseUrl = localServiceUrl(
    'LOCAL_VIDEO_TRANSLATION_URL',
    serverEnv.localVideoTranslationUrl,
  );
  const response = await fetch(new URL('/translate', baseUrl), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => null) as {
    translations?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error || `Local translation service returned HTTP ${response.status}.`);
  }
  if (
    !Array.isArray(body?.translations)
    || body.translations.length !== input.texts.length
    || body.translations.some((text) => typeof text !== 'string' || !text.trim())
  ) {
    throw new Error('Local translation service returned an invalid translation batch.');
  }
  return body.translations as string[];
}
