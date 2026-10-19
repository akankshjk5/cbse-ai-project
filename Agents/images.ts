import 'server-only';

import sharp from 'sharp';

import { serverEnv } from '@/lib/env';
import { selectImageProvider } from './image-providers/select';
import { buildImagePrompt, styleEnvelope, type ImageSubject } from './image-prompt';
import { harmonise } from './palette';
import { recordAgentRun } from './telemetry';
import { AgentError, type StyleSpec } from './types';

/**
 * Illustration generation.
 *
 * Image models are reached over OpenRouter's chat-completions endpoint with
 * `modalities: ['image', 'text']` rather than through the agent SDK, which
 * models the text/tool loop and has nowhere to put an image back. The reply
 * carries the picture as a `data:` URL in `message.images`.
 *
 * Three things are enforced in code rather than asked for in the prompt:
 *
 * 1. **Shape.** Image models honour an aspect ratio and ignore a pixel count:
 *    every one measured here returns about a megapixel whatever it is asked
 *    for. So the request states the intent and Sharp crops the result to the
 *    box's exact ratio afterwards — a slide picture 40px short of its frame
 *    leaves a visible gutter. What Sharp will NOT do is enlarge it; see
 *    `targetSize`.
 * 2. **Style.** The prompt is JSON, not prose: a `style` block derived from the
 *    StyleSpec — identical in every request for a given deck — plus a `subject`
 *    block that is the only thing varying between images. See `image-prompt.ts`
 *    for why. Generated art matches the reference because it is literally the
 *    same style object every time, not because a dozen separately-written
 *    paragraphs happened to describe the same look.
 * 3. **Palette.** That style block asks for the deck's colours and forbids the
 *    rest, which holds right up until the subject has a conventional colour —
 *    ask for a pond and you get green however firmly the prompt forbids it.
 *    `harmonise` maps every pixel's brightness through the deck's own palette
 *    afterwards, which is the only version of this that is reliable. See
 *    ./palette.
 */

/** Where the shipped ComfyUI graphs live, for the local provider. */
const WORKFLOW_DIR = 'ops/runpod/workflows/api';

/** Named slide-image sizes, in pixels. 2x the 96dpi slide canvas. */
export const IMAGE_SIZES = {
  /** Edge-to-edge slide background / full-bleed hero. */
  'slide-16:9': { width: 2560, height: 1440 },
  'slide-4:3': { width: 1920, height: 1440 },
  /** Half-slide illustration beside a text column. */
  half: { width: 1280, height: 1440 },
  /** Inline spot illustration or icon-scale art. */
  spot: { width: 768, height: 768 },
} as const;

export type ImageSizeName = keyof typeof IMAGE_SIZES;
export interface ImageSize {
  width: number;
  height: number;
}

export interface GenerateImageInput {
  /** What the picture should show. Subject only — style comes from `styleSpec`. */
  prompt: string;
  /** A named slide size, or explicit pixels. Never left to the model. */
  size: ImageSizeName | ImageSize;
  /**
   * The deck's visual system. Without one the model is free to invent a look,
   * which is the single thing a deck's illustrations must not do — so a spec
   * is effectively required in a real build, optional only for smoke tests.
   */
  styleSpec?: StyleSpec;
  /** Concrete things the picture must contain, when the caller knows them. */
  objects?: string[];
  /** The slide's own words, so the subject is specific rather than decorative. */
  context?: string;
  /** Where the image sits, which changes how it should be framed. */
  role?: ImageSubject['role'];
}

export interface GenerateImageOutput {
  /** PNG bytes, exactly `width` x `height`. */
  data: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  model: string;
}

function resolveSize(size: ImageSizeName | ImageSize): ImageSize {
  return typeof size === 'string' ? IMAGE_SIZES[size] : size;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioLabel({ width, height }: ImageSize): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * The size to crop to: the box's shape, at no more than the model's own detail.
 *
 * Every image model measured here returns roughly one megapixel no matter what
 * pixel count the prompt asks for. The old code resized to the request anyway,
 * which meant a half-slide illustration was a 976px image stretched to 1280px
 * — softer than the picture the model actually drew, and larger on disk for
 * the privilege. Enlarging cannot add detail; it can only spend bytes blurring
 * the detail that is there.
 *
 * So the box's aspect ratio is honoured exactly (the builder fills its frame
 * with `cover`, and a mismatched ratio crops the subject) while the resolution
 * is capped at what came back. A slide picture at ~140dpi is comfortably sharp
 * projected and in PowerPoint; a fake 192dpi is not sharper, only bigger.
 */
function targetSize(requested: ImageSize, native: ImageSize): ImageSize {
  if (!native.width || !native.height) return requested;

  // How far the request would have to shrink to fit inside the native image.
  const scale = Math.min(
    1,
    native.width / requested.width,
    native.height / requested.height,
  );

  if (scale >= 1) return requested;

  return {
    width: Math.max(1, Math.round(requested.width * scale)),
    height: Math.max(1, Math.round(requested.height * scale)),
  };
}

/*
 * The OpenRouter transport that used to live here — retry policy, the
 * chat-completions payload, and pulling a `data:` URL out of the reply —
 * moved to Agents/image-providers/openrouter.ts. It was the only reason
 * this file knew a vendor's URL, and keeping a second copy beside the
 * provider would have been one to drift.
 */

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
  const { prompt, styleSpec, objects, context, role } = input;
  const size = resolveSize(input.size);
  const model = serverEnv.openRouterImageModel;

  if (!serverEnv.imagesEnabled) {
    throw new AgentError(
      'Image generation is disabled (OPENROUTER_IMAGE_TIER=off).',
      'IMAGE_GENERATION_DISABLED',
      'image-generator',
    );
  }

  // Without a spec there is no house style to hold to, so the prompt degrades
  // to the subject alone rather than pretending to a look it does not have.
  const fullPrompt = styleSpec
    ? buildImagePrompt({
        style: styleEnvelope(styleSpec),
        subject: { description: prompt, objects, context, role },
        output: { width: size.width, height: size.height, aspectRatio: ratioLabel(size) },
      })
    : [
        'ABSOLUTE RULE: the finished image must contain ZERO visible text — no',
        'letters, words, numbers, labels or captions. This is illustration only.',
        '',
        prompt,
        `Output a single ${ratioLabel(size)} image at ${size.width}x${size.height} pixels.`,
        'No text, no lettering, no watermarks, no borders — type is added by the deck itself.',
      ].join('\n');

  // The two dialects are built together and the provider takes the one it
  // speaks. Z-Image reads a concise descriptive line; sending it the long
  // structured brief written for a chat model produces a picture of the brief.
  const captionPrompt = [
    prompt,
    objects?.length ? `Include: ${objects.join(', ')}.` : '',
    context ? `Context: ${context}.` : '',
    'No text, letters, numbers or labels anywhere in the image.',
  ].filter(Boolean).join(' ');

  const startedAt = Date.now();
  const selected = await selectImageProvider({
    comfyUrl: serverEnv.localVideoComfyUrl,
    workflowDir: WORKFLOW_DIR,
    // Read only if the policy actually selects the paid provider, so a
    // self-hosted deployment with no key can still reach this line.
    openRouterApiKey: () => serverEnv.openRouterApiKey,
    openRouterModel: model,
  });

  let produced;
  try {
    produced = await selected.provider.generate({
      prompts: { spec: fullPrompt, caption: captionPrompt },
      width: size.width,
      height: size.height,
      aspectRatio: ratioLabel(size),
    });
  } catch (error) {
    recordAgentRun({
      agent: 'tool:generate_image',
      attempt: 0,
      status: 'failed',
      model: selected.provider.model,
      input: { prompt: fullPrompt, size, provider: selected.provider.id },
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    // Rethrown, never substituted. A deployment that chose local generation
    // and cannot reach its GPU must not quietly become a charge somewhere else.
    throw new AgentError(
      `Image generation failed on ${selected.provider.id}: `
      + `${error instanceof Error ? error.message : String(error)}`,
      'IMAGE_GENERATION_FAILED',
      'image-generator',
    );
  }

  recordAgentRun({
    agent: 'tool:generate_image',
    attempt: 0,
    status: 'succeeded',
    model: produced.model,
    input: { prompt: fullPrompt, size, provider: produced.provider, reason: selected.reason },
    // The image itself is megabytes — record what it was, not the file.
    output: { size, mimeType: produced.mimeType },
    promptTokens: produced.usage.promptTokens,
    completionTokens: produced.usage.completionTokens,
    costUsd: produced.usage.costUsd,
    latencyMs: Date.now() - startedAt,
  });

  const source = sharp(produced.data);
  const { width: nativeWidth = 0, height: nativeHeight = 0 } = await source.metadata();

  // The model's aspect ratio is advisory; the slide's is not. Its resolution,
  // on the other hand, is the most this picture will ever genuinely have.
  const target = targetSize(size, { width: nativeWidth, height: nativeHeight });

  const resized = await source
    .resize(target.width, target.height, {
      fit: 'cover',
      position: 'attention',
      kernel: 'lanczos3',
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Last, so it applies to exactly the pixels that reach the slide.
  const data = styleSpec
    ? await harmonise(resized, styleSpec, serverEnv.imagePaletteStrength)
    : resized;

  return { data, mimeType: 'image/png', width: target.width, height: target.height,
           model: produced.model };
}
