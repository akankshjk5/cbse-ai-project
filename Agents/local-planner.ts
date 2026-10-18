import 'server-only';

/**
 * Structured generation on our own planner, for the deck pipeline.
 *
 * The deck path has always required OpenRouter. `Agent.ts` constructed its
 * client at module scope from `serverEnv.openRouterApiKey`, which throws when
 * the key is absent — so importing anything that reached Agent.ts failed on a
 * deployment that had deliberately chosen to run entirely on its own hardware.
 * The whole lesson-video path is self-hosted; the deck was not, and the
 * failure arrived as an import error rather than as a policy decision.
 *
 * This is the same service the lesson planner already uses:
 * `ops/runpod/local_planner_service.py`, serving `/structured` with
 * `{systemPrompt, userPrompt, jsonSchema, maxNewTokens}` and answering
 * `{output, model}`. The shape was read from that file, not chosen here.
 *
 * It is NOT a drop-in for everything `Agent.ts` does. Reasoning traces, web
 * search and image inputs have no equivalent on this service, and a caller
 * that needs them is told so rather than silently served something lesser.
 */

import { z } from 'zod';

import { serverEnv } from '@/lib/env';

const PATH = '/structured';

export class LocalPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalPlannerError';
  }
}

export interface LocalStructuredRequest<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  /** Bounded by the service at 512..5000. */
  maxNewTokens?: number;
  timeoutMs?: number;
}

export interface LocalStructuredResult<T> {
  value: T;
  model: string | null;
}

/**
 * Whether this deployment can serve structured generation locally.
 *
 * Checked by reachability rather than configuration: a URL in an environment
 * variable says what someone intended, not what is running.
 */
export async function localPlannerReachable(timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`${serverEnv.localVideoAgentUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * One schema-constrained generation on the local planner.
 *
 * The Zod schema is converted rather than described twice: two hand-written
 * copies of the same shape drift, and the one the service constrains against
 * would stop matching the one the caller parses with.
 */
export async function generateStructuredLocally<T>(
  request: LocalStructuredRequest<T>,
): Promise<LocalStructuredResult<T>> {
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(request.schema, { io: 'output' });
  } catch (error) {
    throw new LocalPlannerError(
      `This schema cannot be expressed as JSON Schema, so the local planner `
      + `cannot be constrained to it: ${(error as Error).message}`);
  }

  const url = `${serverEnv.localVideoAgentUrl}${PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        jsonSchema,
        maxNewTokens: Math.max(512, Math.min(5000, request.maxNewTokens ?? 3200)),
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 600_000),
    });
  } catch (error) {
    throw new LocalPlannerError(
      `Could not reach the local planner at ${serverEnv.localVideoAgentUrl}: `
      + `${(error as Error).message}. Start it, or name 'plan' in `
      + `EXTERNAL_PROVIDERS to use a paid provider deliberately.`);
  }

  if (!response.ok) {
    throw new LocalPlannerError(
      `Local planner returned HTTP ${response.status}`);
  }

  const envelope = await response.json() as { output?: unknown; model?: string };
  if (envelope.output === undefined) {
    throw new LocalPlannerError('Local planner returned no output field');
  }

  // Parsed, not trusted. A constrained decoder still produces text, and text
  // that merely looks like the schema would fail further down the pipeline
  // where the cause is much harder to see.
  const parsed = request.schema.safeParse(envelope.output);
  if (!parsed.success) {
    throw new LocalPlannerError(
      `Local planner output did not satisfy the schema: `
      + parsed.error.issues.slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '));
  }
  return { value: parsed.data, model: envelope.model ?? null };
}
