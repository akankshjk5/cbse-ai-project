import {
  ImageProviderError,
  fetchWithRetry,
  type FetchLike,
  type ImageProvider,
  type ImageRequest,
  type ProviderImage,
} from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterImageConfig {
  apiKey: string;
  /** e.g. `google/gemini-3.1-flash-lite-image`. */
  model: string;
  fetchImpl?: FetchLike;
  retryDelaysMs?: readonly number[];
}

interface OpenRouterImageReply {
  choices?: Array<{
    message?: { images?: Array<{ image_url?: { url?: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/**
 * Image models reached over OpenRouter's chat-completions endpoint with
 * `modalities: ['image', 'text']`. The picture comes back as a `data:` URL in
 * `message.images`. This is the pipeline's original, and still default,
 * provider — moved here unchanged so the others can sit beside it.
 */
export class OpenRouterImageProvider implements ImageProvider {
  readonly id = 'openrouter';
  readonly promptStyle = 'spec' as const;
  readonly model: string;

  constructor(private readonly config: OpenRouterImageConfig) {
    this.model = config.model;
  }

  async generate(request: ImageRequest, signal?: AbortSignal): Promise<ProviderImage> {
    const doFetch = this.config.fetchImpl ?? fetch;

    const response = await fetchWithRetry(
      this.id,
      () =>
        doFetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            modalities: ['image', 'text'],
            messages: [{ role: 'user', content: request.prompts.spec }],
          }),
          signal,
        }),
      this.config.retryDelaysMs,
    );

    if (!response.ok) {
      throw new ImageProviderError(
        `Image generation failed (${response.status}): ${await response.text()}`,
        'HTTP',
        this.id,
        response.status,
      );
    }

    const reply = (await response.json()) as OpenRouterImageReply;
    const url = reply.choices?.[0]?.message?.images?.[0]?.image_url?.url;

    if (!url?.startsWith('data:')) {
      throw new ImageProviderError(
        reply.error?.message
          ? `Image model returned an error: ${reply.error.message}`
          : 'Image model returned no image. Check that OPENROUTER_IMAGE_MODEL is an image-output model.',
        'EMPTY',
        this.id,
      );
    }

    const comma = url.indexOf(',');
    const mimeType = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png';

    return {
      data: Buffer.from(url.slice(comma + 1), 'base64'),
      mimeType,
      provider: this.id,
      model: this.model,
      usage: {
        promptTokens: reply.usage?.prompt_tokens,
        completionTokens: reply.usage?.completion_tokens,
        costUsd: reply.usage?.cost,
      },
    };
  }
}
