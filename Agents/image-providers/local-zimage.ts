import {
  ImageProviderError,
  type FetchLike,
  type ImageProvider,
  type ImageRequest,
  type ProviderImage,
} from './types';

/**
 * Z-Image Turbo on our own ComfyUI, implementing the same interface the paid
 * providers do.
 *
 * `Agents/image-providers/` already defined `ImageProvider` with two
 * implementations, and nothing imported any of it — `Agents/images.ts`
 * hardcoded OpenRouter's URL instead. So the abstraction that would make a
 * local provider easy existed and was unplugged, which reads from the outside
 * like the work was done.
 *
 * The ComfyUI calls here are the ones `ops/runpod/media_worker.py` makes:
 * `POST /prompt`, poll `GET /history/{id}`, fetch through `GET /view`. The
 * workflow is the shipped `image-fast.json`, filled through the same
 * `__SLOT__` substitution `ops/cloud/local_models.py` uses, so one graph
 * serves the lesson pipeline and the deck pipeline rather than two drifting
 * copies.
 *
 * There is no fallback in this file. A deployment that chose local generation
 * and cannot reach its own GPU gets an error naming the service, not a
 * surprise bill from a provider it had switched off.
 */

export interface LocalZImageConfig {
  /** ComfyUI's base URL, e.g. `http://127.0.0.1:8188`. */
  comfyUrl: string;
  /** The parsed `image-fast.json` graph. */
  workflow: Record<string, unknown>;
  /** Model identity for provenance, e.g. `z-image-turbo@bf16`. */
  model?: string;
  fetchImpl?: FetchLike;
  /** How long one picture may take before the attempt is abandoned. */
  deadlineMs?: number;
  pollMs?: number;
}

interface ComfyOutputRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

const PROVIDER = 'local-zimage';

export class LocalZImageProvider implements ImageProvider {
  readonly id = PROVIDER;
  /**
   * `caption`, not `spec`. The spec dialect is written for a chat model that
   * reads a long structured brief; Z-Image takes a single descriptive line.
   * Sending the wrong dialect produces a picture of the brief.
   */
  readonly promptStyle = 'caption' as const;
  readonly model: string;

  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: LocalZImageConfig) {
    this.model = config.model ?? 'z-image-turbo@bf16';
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
    if (!config.comfyUrl) {
      throw new ImageProviderError(
        'LOCAL_VIDEO_COMFY_URL is not set, so the local image provider has nowhere to send work',
        'CONFIG', PROVIDER);
    }
  }

  async generate(request: ImageRequest, signal?: AbortSignal): Promise<ProviderImage> {
    const base = this.config.comfyUrl.replace(/\/$/, '');
    const filled = fillWorkflow(this.config.workflow, {
      prompt: request.prompts.caption,
      // ComfyUI's latent nodes want multiples of 8; a size that is not is
      // rejected deep in validation with a message about tensor shapes.
      width: roundTo8(request.width),
      height: roundTo8(request.height),
      seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    });

    const queued = await this.post(`${base}/prompt`, { prompt: filled }, signal);
    const promptId = (queued as { prompt_id?: string }).prompt_id;
    if (!promptId) {
      throw new ImageProviderError(
        `ComfyUI refused the workflow: ${JSON.stringify(queued).slice(0, 300)}`,
        'HTTP', PROVIDER);
    }

    const entry = await this.awaitPrompt(base, promptId, signal);
    const output = firstImage(entry);
    if (!output) {
      throw new ImageProviderError(
        `ComfyUI finished ${promptId} but saved no image; check the workflow's SaveImage node`,
        'EMPTY', PROVIDER);
    }

    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder ?? '',
      type: output.type ?? 'output',
    });
    const view = await this.fetchImpl(`${base}/view?${query}`, { signal });
    if (!view.ok) {
      throw new ImageProviderError(
        `Could not download ${output.filename} from ComfyUI`, 'HTTP', PROVIDER, view.status);
    }
    const data = Buffer.from(await view.arrayBuffer());
    if (data.length === 0 || !isPng(data)) {
      // A ComfyUI error page is a 200 with HTML in it. Stored unchecked, that
      // becomes a slide whose illustration is markup.
      throw new ImageProviderError(
        `ComfyUI returned ${data.length} bytes that are not a PNG`, 'EMPTY', PROVIDER);
    }

    return {
      data,
      mimeType: 'image/png',
      provider: PROVIDER,
      model: this.model,
      // Self-hosted work has no per-image price. Leaving `costUsd` undefined
      // is the honest value; zero would read as a measured free lesson.
      usage: {},
    };
  }

  private async post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new ImageProviderError(
        `Could not reach ComfyUI at ${this.config.comfyUrl}: ${(error as Error).message}. `
        + `Start it, or enable an external image provider deliberately.`,
        'NETWORK', PROVIDER);
    }
    if (!response.ok) {
      throw new ImageProviderError(
        `ComfyUI returned HTTP ${response.status}`, 'HTTP', PROVIDER, response.status);
    }
    return response.json();
  }

  private async awaitPrompt(
    base: string, promptId: string, signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (this.config.deadlineMs ?? 900_000);
    const poll = this.config.pollMs ?? 2000;
    for (;;) {
      if (Date.now() > deadline) {
        throw new ImageProviderError(
          `ComfyUI job ${promptId} did not finish in time; check its log for an `
          + `out-of-memory or missing-model error`, 'NETWORK', PROVIDER);
      }
      const response = await this.fetchImpl(`${base}/history/${promptId}`, { signal });
      if (response.ok) {
        const history = await response.json() as Record<string, Record<string, unknown>>;
        const entry = history[promptId];
        if (entry) {
          const status = (entry.status ?? {}) as { status_str?: string };
          if (status.status_str === 'error') {
            throw new ImageProviderError(
              `ComfyUI job ${promptId} failed`, 'HTTP', PROVIDER);
          }
          return entry;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }
}

/**
 * Fill the `__SLOT__` placeholders, writing each exactly once.
 *
 * Deliberately never re-reads what it wrote: a caption that happens to contain
 * `__SEED__` is ordinary content, and a second pass would both refuse it and
 * let a prompt rewrite the graph.
 */
export function fillWorkflow(
  template: Record<string, unknown>, values: Record<string, unknown>,
): Record<string, unknown> {
  const filled = JSON.parse(JSON.stringify(template)) as Record<string, {
    inputs?: Record<string, unknown>;
  }>;
  const missing: string[] = [];
  for (const [nodeId, node] of Object.entries(filled)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || !value.startsWith('__') || !value.endsWith('__')) continue;
      const name = value.slice(2, -2).toLowerCase();
      if (!(name in values)) { missing.push(`${value} (${nodeId}.${key})`); continue; }
      inputs[key] = values[name];
    }
  }
  if (missing.length) {
    throw new ImageProviderError(
      `Workflow slots with no value: ${missing.join(', ')}`, 'CONFIG', PROVIDER);
  }
  return filled as Record<string, unknown>;
}

function firstImage(entry: Record<string, unknown>): ComfyOutputRef | null {
  const outputs = (entry.outputs ?? {}) as Record<string, { images?: ComfyOutputRef[] }>;
  for (const node of Object.values(outputs)) {
    const image = node.images?.[0];
    if (image?.filename) return image;
  }
  return null;
}

const roundTo8 = (value: number) => Math.max(8, Math.round(value / 8) * 8);
const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
