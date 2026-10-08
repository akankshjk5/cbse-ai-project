import 'server-only';

import { readFile, stat } from 'node:fs/promises';

import { AgentError, type Tool } from '../types';

/**
 * Technical validation: does this file exist, and is it actually a PPTX?
 *
 * A .pptx is a ZIP (OPC package), so a valid one starts with the `PK` local
 * file header and contains `[Content_Types].xml`. Checking that catches a
 * truncated or half-written deck before the user downloads it — the cheap
 * check that must pass before anything is returned.
 */

export interface ValidatePptxInput {
  pptxPath: string;
  expectedSlideCount?: number;
}

export interface ValidatePptxOutput {
  valid: boolean;
  bytes: number;
  slideCount: number;
  problems: string[];
}

const ZIP_SIGNATURE = 'PK';

export const validatePptx: Tool<ValidatePptxInput, ValidatePptxOutput> = {
  name: 'validate_pptx',
  description:
    'Confirms the .pptx exists, is a well-formed OPC package, and matches the expected slide count.',

  async execute({ pptxPath, expectedSlideCount }) {
    const problems: string[] = [];

    let bytes: number;
    try {
      bytes = (await stat(pptxPath)).size;
    } catch {
      throw new AgentError(
        `Generated deck not found at ${pptxPath}`,
        'PPTX_NOT_FOUND',
        'validate-pptx',
      );
    }

    if (bytes === 0) problems.push('File is empty');

    const buffer = await readFile(pptxPath);
    if (buffer.subarray(0, 2).toString('latin1') !== ZIP_SIGNATURE) {
      problems.push('File is not a valid OPC (zip) package');
    }

    const asText = buffer.toString('latin1');
    if (!asText.includes('[Content_Types].xml')) {
      problems.push('Package is missing [Content_Types].xml');
    }

    // Slide parts are stored as ppt/slides/slideN.xml; counting the distinct
    // entries is enough to verify the deck's length without unzipping.
    const slideCount = new Set(asText.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).size;

    if (slideCount === 0) problems.push('Package contains no slides');

    if (expectedSlideCount !== undefined && slideCount !== expectedSlideCount) {
      problems.push(`Expected ${expectedSlideCount} slides, found ${slideCount}`);
    }

    return { valid: problems.length === 0, bytes, slideCount, problems };
  },
};
