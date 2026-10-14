/**
 * The seam between "make me a picture" and whoever makes it.
 *
 * `Agents/images.ts` owns everything that is the *deck's* business: building
 * the prompt from the StyleSpec, cropping to the box's exact ratio, pulling the
 * pixels into the palette. A provider owns exactly one thing — turning a prompt
 * into image bytes over some API — and nothing here may import the deck, the
 * StyleSpec or the environment. That is what makes a provider swappable, and
 * what makes each one testable with a fake `fetch`.
 */

/**
 * How a provider wants to be prompted.
 *
 * - `spec`: an instruction-following multimodal model (Gemini "Nano Banana").
 *   It reads the long JSON specification and the "never draw text" rules.
 * - `caption`: a diffusion model (Flux, SDXL). It wants a short visual
 *   description; a wall of rules mentioning "text" makes it draw text.
 */
export type PromptStyle = 'spec' | 'caption';

export interface ImageRequest {
  /** Both renderings of the same request; the provider takes the one it speaks. */
  prompts: { spec: string; caption: string };
  /** What the caller would like. Providers may return another size. */
  width: number;
  height: number;
  /** e.g. `16:9`. */
  aspectRatio: string;
  seed?: number;
}

export interface ImageUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** What this one image cost, in USD, when the provider can say. */
  costUsd?: number;
}

export interface ProviderImage {
  data: Buffer;
  mimeType: string;
  provider: string;
  model: string;
  usage: ImageUsage;
}

export interface ImageProvider {
  /** Stable key used in env vars, logs and the circuit breaker. */
  readonly id: string;
  readonly model: string;
  readonly promptStyle: PromptStyle;
  generate(request: ImageRequest, signal?: AbortSignal): Promise<ProviderImage>;
}

/**
 * Every provider failure arrives as one of these, so the chain can decide
 * whether to fall back without knowing which vendor spoke.
 */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'HTTP' | 'EMPTY' | 'NETWORK' | 'CONFIG',
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Rate limits and overload are routine on image APIs; a 400 never is. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export const DEFAULT_RETRY_DELAYS_MS = [1500, 5000] as const;

/**
 * Runs `attempt`, retrying transient HTTP failures and network errors.
 *
 * A deck asks for several images back to back — exactly the shape that trips a
 * per-minute limit — and losing a picture to a 429 that would have succeeded
 * two seconds later wastes a build. Non-transient statuses return immediately
 * so the caller can read the body and report it.
 */
export async function fetchWithRetry(
  provider: string,
  attempt: () => Promise<Response>,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<Response> {
  for (let n = 0; ; n++) {
    let response: Response | undefined;
    let failure: unknown;

    try {
      response = await attempt();
    } catch (error) {
      failure = error;
    }

    const transient = response ? isTransientStatus(response.status) : true;
    if (response && (response.ok || !transient)) return response;

    if (n >= delaysMs.length) {
      if (response) return response;
      throw new ImageProviderError(
        `${provider}: network error — ${failure instanceof Error ? failure.message : String(failure)}`,
        'NETWORK',
        provider,
      );
    }

    console.warn(
      `[images] ${provider} ${response ? `returned ${response.status}` : 'network error'} — retrying in ${delaysMs[n]}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delaysMs[n]));
  }
}
