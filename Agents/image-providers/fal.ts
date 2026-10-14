import {
  ImageProviderError,
  fetchWithRetry,
  type FetchLike,
  type ImageProvider,
  type ImageRequest,
  type ProviderImage,
} from './types';

export interface FalImageConfig {
  apiKey: string;
  /** fal endpoint id. Default is FLUX.1 [schnell]. */
  model?: string;
  /** schnell is distilled for 1-4 steps; 4 is its default. */
  steps?: number;
  /** USD per started megapixel. FLUX.1 [schnell] is listed at $0.003. */
  usdPerMegapixel?: number;
  fetchImpl?: FetchLike;
  retryDelaysMs?: readonly number[];
}

export const FAL_FLUX_SCHNELL = 'fal-ai/flux/schnell';

/** fal bills by megapixel rounded UP, so 1.0MP is the largest size that is "one". */
const TARGET_PIXELS = 1_000_000;
const MIN_EDGE = 512;

/**
 * The size to ask fal for: the request's shape, at no more than one megapixel,
 * on the 16px grid diffusion models want.
 *
 * Like the other models measured in this repo, the result is about a megapixel
 * whatever the slide asks for, and `images.ts` crops to the exact ratio after.
 * Rounding *down* keeps the product at or under 1MP, which is the price step.
 */
export function falSizeFor(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(TARGET_PIXELS / (width * height)));
  const snap = (edge: number) => Math.max(MIN_EDGE, Math.floor((edge * scale) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

interface FalReply {
  images?: Array<{ url?: string; content_type?: string }>;
  detail?: unknown;
}

/**
 * FLUX.1 [schnell] (or any fal text-to-image endpoint with the same shape) over
 * fal's synchronous REST API. Four sampling steps, roughly a cent-fraction per
 * image, no reasoning tokens — the cost the OpenRouter/Gemini path cannot reach.
 *
 * Takes the `caption` prompt: a diffusion model reads a short visual description,
 * not a rulebook, and a rule that names "text" makes it more likely to draw some.
 */
export class FalImageProvider implements ImageProvider {
  readonly id = 'fal';
  readonly promptStyle = 'caption' as const;
  readonly model: string;

  constructor(private readonly config: FalImageConfig) {
    this.model = config.model ?? FAL_FLUX_SCHNELL;
  }

  async generate(request: ImageRequest, signal?: AbortSignal): Promise<ProviderImage> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const size = falSizeFor(request.width, request.height);

    const response = await fetchWithRetry(
      this.id,
      () =>
        doFetch(`https://fal.run/${this.model}`, {
          method: 'POST',
          headers: {
            Authorization: `Key ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: request.prompts.caption,
            image_size: size,
            num_inference_steps: this.config.steps ?? 4,
            num_images: 1,
            output_format: 'png',
            enable_safety_checker: true,
            ...(request.seed === undefined ? {} : { seed: request.seed }),
          }),
          signal,
        }),
      this.config.retryDelaysMs,
    );

    if (!response.ok) {
      throw new ImageProviderError(
        `fal image generation failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
        'HTTP',
        this.id,
        response.status,
      );
    }

    const reply = (await response.json()) as FalReply;
    const first = reply.images?.[0];
    if (!first?.url) {
      throw new ImageProviderError('fal returned no image.', 'EMPTY', this.id);
    }

    // Results are served as a URL (or a data: URI); fetching is a plain GET.
    const imageResponse = await fetchWithRetry(
      this.id,
      () => doFetch(first.url as string, { signal }),
      this.config.retryDelaysMs,
    );
    if (!imageResponse.ok) {
      throw new ImageProviderError(
        `fal image download failed (${imageResponse.status})`,
        'HTTP',
        this.id,
        imageResponse.status,
      );
    }

    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (data.length === 0) {
      throw new ImageProviderError('fal returned an empty image.', 'EMPTY', this.id);
    }

    const megapixels = Math.ceil((size.width * size.height) / 1_000_000);

    return {
      data,
      mimeType: first.content_type ?? imageResponse.headers.get('content-type') ?? 'image/png',
      provider: this.id,
      model: this.model,
      usage: { costUsd: megapixels * (this.config.usdPerMegapixel ?? 0.003) },
    };
  }
}
