import 'server-only';

import { generateImage, type ImageSize, type ImageSizeName } from '../images';
import type { ImageSubject } from '../image-prompt';
import { AgentError, type StyleSpec, type Tool } from '../types';

/**
 * Image generation, as a tool.
 *
 * Making a picture is not a specialist's job — there is no reasoning in it and
 * nothing to decide. An agent decides *what* the picture should show; turning
 * that sentence into pixels is a deterministic call to a provider, exactly like
 * measuring an image or checking a font. So it lives in the registry with the
 * other tools, and any agent can invoke it.
 *
 * The registry is the boundary that makes that safe: a skill's Markdown can
 * name this tool, but only because it is registered here in code.
 */

export interface GenerateImageToolInput {
  /** What the picture should show. Subject and composition only. */
  prompt: string;
  /** A named slide size, or explicit pixels. Never left to the model. */
  size: ImageSizeName | ImageSize;
  /**
   * The deck's visual system. Becomes the locked `style` block of the JSON
   * prompt — identical for every image in the build.
   */
  styleSpec?: StyleSpec;
  /** Concrete things this picture must contain. Part of the varying half. */
  objects?: string[];
  /** The slide's own words, so the subject is specific rather than decorative. */
  context?: string;
  /** Where the image sits, which changes how it is framed. */
  role?: ImageSubject['role'];
}

export interface GenerateImageToolOutput {
  /** Base64 PNG. The caller decides where it is written. */
  base64: string;
  width: number;
  height: number;
  model: string;
}

export const generateImageTool: Tool<GenerateImageToolInput, GenerateImageToolOutput> = {
  name: 'generate_image',
  description:
    'Generates one illustration from a description, at an exact pixel size, in the deck\'s own palette and visual language. The style half of the prompt is fixed by the StyleSpec; only the subject varies. Returns PNG bytes; never a file path.',

  async execute({ prompt, size, styleSpec, objects, context, role }) {
    if (!prompt?.trim()) {
      throw new AgentError(
        'generate_image needs a prompt describing what the picture shows',
        'IMAGE_PROMPT_MISSING',
        'generate-image',
      );
    }

    const image = await generateImage({ prompt, size, styleSpec, objects, context, role });

    return {
      base64: image.data.toString('base64'),
      width: image.width,
      height: image.height,
      model: image.model,
    };
  },
};
