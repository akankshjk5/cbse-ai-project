import 'server-only';

import sharp from 'sharp';

import { AgentError, type Tool } from '../types';

/**
 * Deterministic half of style analysis.
 *
 * Sharp gives us the facts an image actually contains — dimensions, aspect
 * ratio, and a dominant colour — so the model is left to interpret design
 * language rather than guess numbers it cannot measure. The Style Analyzer
 * specialist combines this output with its own visual reading.
 */

export interface AnalyzeStyleImageInput {
  imagePath: string;
}

export interface AnalyzeStyleImageOutput {
  width: number;
  height: number;
  aspectRatio: '16:9' | '4:3' | 'custom';
  format: string;
  dominantColor: string;
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function classifyAspectRatio(width: number, height: number): '16:9' | '4:3' | 'custom' {
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(ratio - 4 / 3) < 0.05) return '4:3';
  return 'custom';
}

/**
 * Loads the reference image as a `data:` URL for the vision model.
 *
 * Downscaled to 1568px on the long edge and re-encoded as PNG: the style
 * analyzer reads composition, palette and type hierarchy, none of which need
 * more, and a full-resolution export otherwise spends the request on pixels.
 */
export async function readStyleImageAsDataUrl(imagePath: string): Promise<string> {
  try {
    const png = await sharp(imagePath)
      .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (error) {
    throw new AgentError(
      `Could not read style reference ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
      'STYLE_IMAGE_UNREADABLE',
      'analyze-style-image',
    );
  }
}

export const analyzeStyleImage: Tool<AnalyzeStyleImageInput, AnalyzeStyleImageOutput> = {
  name: 'analyze_style_image',
  description:
    'Extracts deterministic facts (dimensions, aspect ratio, format, dominant colour) from the style reference image.',

  async execute({ imagePath }) {
    try {
      const image = sharp(imagePath);
      const { width, height, format } = await image.metadata();

      if (!width || !height) {
        throw new AgentError(
          `Could not read dimensions from ${imagePath}`,
          'STYLE_IMAGE_UNREADABLE',
          'analyze-style-image',
        );
      }

      const { dominant } = await image.stats();

      return {
        width,
        height,
        aspectRatio: classifyAspectRatio(width, height),
        format: format ?? 'unknown',
        dominantColor: toHex(dominant),
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        `Style image analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        'STYLE_IMAGE_ANALYSIS_FAILED',
        'analyze-style-image',
      );
    }
  },
};
