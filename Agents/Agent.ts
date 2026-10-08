import 'server-only';

import { OpenRouter } from '@openrouter/agent';
import { z } from 'zod';

import { serverEnv } from '@/lib/env';
import { recordReasoning } from './reasoning';
import { recordAgentRun } from './telemetry';
import { AgentError } from './types';

/**
 * The reasoning engine the specialists run on.
 *
 * Two entry points: `chat` for free-text, and `generateStructured` for the
 * case that actually matters here — model output that must satisfy a schema
 * before the next pipeline stage is allowed to see it.
 *
 * Every call asks for reasoning and streams it back out through
 * `./reasoning`, because a deck is a dozen sequential judgements and the only
 * way to debug a bad one is to read the argument that produced it.
 */

const openrouter = new OpenRouter({
  apiKey: serverEnv.openRouterApiKey,
});

export type ChatMessage = {
  role: 'user' | 'system';
  content: string;
  /** Optional images attached to a user turn, as `data:` URLs. */
  images?: string[];
};

type UserContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail: 'high'; imageUrl: string };

function splitMessages(messages: ChatMessage[]) {
  return {
    instructions: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n'),
    input: messages
      .filter((m) => m.role === 'user')
      .map((m) => {
        if (!m.images?.length) return { role: 'user' as const, content: m.content };

        const content: UserContentPart[] = [
          { type: 'input_text', text: m.content },
          ...m.images.map(
            (imageUrl): UserContentPart => ({ type: 'input_image', detail: 'high', imageUrl }),
          ),
        ];
        return { role: 'user' as const, content };
      }),
  };
}

/** How hard a stage is allowed to think. Maps to OpenRouter's reasoning effort. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Live web search, as a per-call option rather than a tool.
 *
 * OpenRouter runs the search itself and folds the results into the prompt, so
 * the researcher does not need a search API key of its own and the citations
 * arrive in the same reply as the analysis. `native` asks the provider to use
 * its own grounding — on a Gemini model that is Google Search — and falls back
 * to OpenRouter's own engine when the provider has none.
 */
export interface WebSearchOptions {
  engine?: 'native' | 'exa' | 'firecrawl' | 'parallel' | 'perplexity';
  maxResults?: number;
  /** Steers what the search is for, separate from the task prompt. */
  searchPrompt?: string;
}

export interface ChatResult {
  text: string;
  model: string;
  /** The model's thinking, if it emitted any. Empty string when it did not. */
  reasoning: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * Undefined when OpenRouter reported no cost accounting for the generation
   * — some providers do not return it. Recorded as null rather than guessed.
   */
  costUsd?: number;
  latencyMs: number;
}

/**
 * Everything the provider told us about a failure.
 *
 * `OpenRouterError` carries `statusCode` and `body`, and the SDK's own message
 * is often just "Provider returned error" — useless on its own. Losing the
 * status and body turns a diagnosable rate limit into an unexplained dead
 * build, so they are pulled out here and put in the message.
 */
function describeFailure(error: unknown, model: string): { message: string; status?: number } {
  const base = error instanceof Error ? error.message : String(error);

  if (error && typeof error === 'object' && 'statusCode' in error) {
    const { statusCode, body } = error as { statusCode: number; body?: string };
    const detail = (body ?? '').slice(0, 500).trim();
    return {
      status: statusCode,
      message: `${model} returned ${statusCode}: ${detail || base}`,
    };
  }

  return { message: `${model}: ${base}` };
}

/**
 * Worth trying again: rate limits, provider overload, gateway hiccups.
 *
 * A 400 or a 401 will fail identically forever, so retrying one only delays
 * the report. Anything without a status is a network fault, which is exactly
 * the case retrying exists for.
 */
function isTransient(status?: number): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const RETRY_DELAYS_MS = [1000, 4000];

/** Reasoning arrives token by token; the log wants readable paragraphs. */
const REASONING_FLUSH_CHARS = 180;

export interface CallOptions {
  model?: string;
  /** Pipeline stage, so reasoning and telemetry can be attributed. */
  stage: string;
  effort?: ReasoningEffort;
  /** Set to run the call with live web search attached. */
  search?: WebSearchOptions;
  /** Bounds one provider request without changing the global SDK timeout. */
  requestTimeoutMs?: number;
  /** Overrides the default transient retry count for latency-sensitive stages. */
  maxTransientRetries?: number;
}

/**
 * Consumes the reasoning stream, forwarding it in readable chunks.
 *
 * Buffered to sentence-ish boundaries: a token-at-a-time feed turns the dev
 * terminal into confetti, and the point of showing the thinking is that a
 * human can read it while the build runs.
 *
 * Never rejects. A provider that emits no reasoning, or an SDK that closes the
 * stream early, must not fail a call that is otherwise fine.
 */
async function drainReasoning(
  stream: AsyncIterableIterator<string>,
  stage: string,
  collected: string[],
): Promise<void> {
  let buffer = '';

  const flush = () => {
    if (!buffer.trim()) {
      buffer = '';
      return;
    }
    recordReasoning(stage, buffer);
    buffer = '';
  };

  try {
    for await (const delta of stream) {
      collected.push(delta);
      buffer += delta;

      // Break on a paragraph if there is one, otherwise on length.
      const paragraph = buffer.lastIndexOf('\n');
      if (paragraph > 0) {
        const head = buffer.slice(0, paragraph);
        buffer = buffer.slice(paragraph + 1);
        recordReasoning(stage, head);
      } else if (buffer.length >= REASONING_FLUSH_CHARS) {
        flush();
      }
    }
  } catch {
    /* a truncated thought is still worth the part we got */
  } finally {
    flush();
  }
}

/**
 * One model call, with what it consumed and what it was thinking.
 *
 * Usage comes from `getUsage()`, not `getResponse().usage`: the latter covers
 * only the final round, so a multi-round call would under-report. It never
 * rejects, so a failed run still yields the tokens it burned.
 *
 * Transient provider failures are retried with a backoff. A deck is a dozen
 * model calls in sequence — at that length a single 429 anywhere kills the
 * whole build, and provider rate limits are routine rather than exceptional.
 */
async function callModel(messages: ChatMessage[], options: CallOptions): Promise<ChatResult> {
  const { instructions, input } = splitMessages(messages);
  const resolvedModel = options.model ?? serverEnv.openRouterModel;
  const effort = options.effort ?? serverEnv.reasoningEffort;
  const maxTransientRetries = options.maxTransientRetries ?? RETRY_DELAYS_MS.length;
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    try {
      const result = openrouter.callModel({
        model: resolvedModel,
        instructions: instructions || undefined,
        input,
        // `summary: 'detailed'` matters for the providers that will not hand
        // back raw chain-of-thought: without it those models stream nothing
        // and the trace for that stage is silently blank.
        reasoning: { enabled: effort !== 'minimal', effort, summary: 'detailed' },
        ...(options.search
          ? {
              plugins: [
                {
                  id: 'web' as const,
                  engine: options.search.engine ?? serverEnv.webSearchEngine,
                  maxResults: options.search.maxResults ?? serverEnv.webSearchMaxResults,
                  ...(options.search.searchPrompt
                    ? { searchPrompt: options.search.searchPrompt }
                    : {}),
                },
              ],
            }
          : {}),
      }, options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : undefined);

      // Started before the text is awaited so the thinking appears in the log
      // while the answer is still being written, not in a burst after it.
      const thoughts: string[] = [];
      const reasoningDone = drainReasoning(result.getReasoningStream(), options.stage, thoughts);

      const text = await result.getText();
      await reasoningDone;
      const usage = await result.getUsage();

      return {
        text,
        model: resolvedModel,
        reasoning: thoughts.join(''),
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        costUsd: usage.cost,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const { message, status } = describeFailure(error, resolvedModel);

      if (attempt >= maxTransientRetries || !isTransient(status)) {
        throw new AgentError(message, status ? `PROVIDER_${status}` : 'PROVIDER_ERROR', 'model');
      }

      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      console.warn(`[model] ${message} — retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Sends `messages` to a model and returns its reply text. */
export async function chat(messages: ChatMessage[], options: CallOptions): Promise<string> {
  return (await callModel(messages, options)).text;
}

/**
 * The schema, as JSON Schema, for the model to read.
 *
 * Prose descriptions of a shape drift from the shape. Sending the real schema
 * means the contract the model is given and the contract it is checked against
 * are the same object — which is the difference between a specialist inventing
 * `{ kind, content, position }` and returning the `SlideElement` the builder
 * needs. `io: 'input'` so fields with defaults read as optional, which they are.
 */
function describeSchema(schema: z.ZodType<unknown>): string | null {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  } catch {
    // A schema JSON Schema cannot express is still worth attempting blind.
    return null;
  }
}

/** Pulls a JSON object out of a reply that may be fenced or prose-wrapped. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return raw.trim();
}

/**
 * Runs a specialist and validates its output against `schema`.
 *
 * Model output is untrusted input: it is parsed and schema-checked here, so a
 * malformed or hallucinated shape fails at the boundary rather than surfacing
 * as a strange PowerPoint three stages later. One retry, with the validation
 * error fed back, since a single nudge fixes most shape mistakes.
 */
export async function generateStructured<T>(
  options: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    stage: string;
    /** Overrides `OPENROUTER_MODEL` — used by the vision stage. */
    model?: string;
    /** `data:` URLs attached to the user turn. Requires a vision-capable model. */
    images?: string[];
    /** How hard this stage may think. Defaults to `OPENROUTER_REASONING_EFFORT`. */
    effort?: ReasoningEffort;
    /** Attaches live web search to the call. */
    search?: WebSearchOptions;
    /** Bounds each provider request for latency-sensitive stages. */
    requestTimeoutMs?: number;
    /** Overrides transport retries; schema-correction retries remain separate. */
    maxTransientRetries?: number;
    /** Bounds schema attempts for latency-sensitive stages. Defaults to 2. */
    maxSchemaAttempts?: 1 | 2;
  },
): Promise<T> {
  const {
    systemPrompt,
    userPrompt,
    schema,
    stage,
    model,
    images,
    effort,
    search,
    requestTimeoutMs,
    maxTransientRetries,
    maxSchemaAttempts = 2,
  } = options;

  const jsonSchema = describeSchema(schema as z.ZodType<unknown>);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        userPrompt,
        jsonSchema
          ? `The response must satisfy this JSON Schema exactly — same field names, same types, no extra nesting:\n${jsonSchema}`
          : '',
        'Respond with JSON only — no prose, no code fence commentary.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      images,
    },
  ];

  let lastError = '';

  for (let attempt = 0; attempt < maxSchemaAttempts; attempt++) {
    const sent =
      attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: 'user' as const,
              content: `Your previous response failed validation: ${lastError}\nReturn corrected JSON only.`,
            },
          ];

    // A call that never comes back still cost something, and the stage it died
    // in is exactly what a failed build needs to explain itself.
    let call: ChatResult;
    const startedAt = Date.now();
    try {
      call = await callModel(sent, {
        model,
        stage,
        effort,
        search,
        requestTimeoutMs,
        maxTransientRetries,
      });
    } catch (error) {
      recordAgentRun({
        agent: stage,
        attempt,
        status: 'failed',
        model: model ?? serverEnv.openRouterModel,
        // The image data URLs are megabytes; the prompts are the useful part.
        input: { systemPrompt, userPrompt, images: images?.length ?? 0 },
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let parsed: T | undefined;
    try {
      parsed = schema.parse(JSON.parse(extractJson(call.text)));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    recordAgentRun({
      agent: stage,
      attempt,
      // A reply that failed the schema is a failed run, even though the model
      // answered — the pipeline could not use what came back.
      status: parsed === undefined ? 'failed' : 'succeeded',
      model: call.model,
      input: { systemPrompt, userPrompt, images: images?.length ?? 0 },
      output: parsed === undefined ? { raw: call.text } : parsed,
      // Carried on the record for the terminal sink. `agent_runs` has no
      // column for it yet, so the durable copy is the trace, not the row.
      reasoning: call.reasoning || undefined,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      costUsd: call.costUsd,
      latencyMs: call.latencyMs,
      error: parsed === undefined ? lastError : undefined,
    });

    if (parsed !== undefined) return parsed;
  }

  throw new AgentError(
    `Model output failed schema validation after ${maxSchemaAttempts} attempt${maxSchemaAttempts === 1 ? '' : 's'}: ${lastError}`,
    'STRUCTURED_OUTPUT_INVALID',
    stage,
  );
}
