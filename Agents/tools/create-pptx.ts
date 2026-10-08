import 'server-only';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildPptx } from '../pptx/builder';
import { AgentError, type SlideSpec, type StyleSpec, type Tool } from '../types';

export const PRESENTATIONS_DIR = path.join(process.cwd(), 'generated', 'presentations');

export interface CreatePptxInput {
  styleSpec: StyleSpec;
  slideSpecs: SlideSpec[];
}

export interface CreatePptxOutput {
  /** Opaque id — this is what the client sees, never the filesystem path. */
  id: string;
  pptxPath: string;
  filename: string;
  slideCount: number;
}

export const createPptx: Tool<CreatePptxInput, CreatePptxOutput> = {
  name: 'create_pptx',
  description: 'Builds a .pptx from the SlideSpec[] and StyleSpec and writes it to disk.',

  async execute({ styleSpec, slideSpecs }) {
    const id = randomUUID();
    const filename = `deck-${id}.pptx`;
    const pptxPath = path.join(PRESENTATIONS_DIR, filename);

    try {
      await mkdir(PRESENTATIONS_DIR, { recursive: true });
      const { slideCount } = await buildPptx(slideSpecs, styleSpec, pptxPath);
      return { id, pptxPath, filename, slideCount };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        `PPTX generation failed: ${error instanceof Error ? error.message : String(error)}`,
        'PPTX_GENERATION_FAILED',
        'create-pptx',
      );
    }
  },
};
