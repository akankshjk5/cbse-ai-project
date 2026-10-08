import 'server-only';

import { AgentError, type Tool } from '../types';

/**
 * Deterministic half of font curation.
 *
 * The style analyzer can only ever *estimate* a typeface from an image, and a
 * model asked to name a Google Font will happily invent one. This tool settles
 * the question against Google's own server: `fonts.googleapis.com/css2` returns
 * 400 for a family it does not host, and for a weight a family does not ship.
 * No API key is involved, which matters — a font check is not worth a key.
 *
 * It answers "does this exist", nothing more. Which family *suits* the
 * reference image is a judgement, and that stays with the Font Curator.
 */

const CSS2_URL = 'https://fonts.googleapis.com/css2';

/** Weights any deck needs: body copy, emphasis, and headings. */
const DEFAULT_WEIGHTS = [400, 700];

export interface CheckGoogleFontInput {
  /** Family name as Google spells it, e.g. `Playfair Display`. */
  family: string;
  /** Weights the deck intends to use. Defaults to 400 and 700. */
  weights?: number[];
}

export interface CheckGoogleFontOutput {
  family: string;
  /** Whether Google Fonts hosts this family at all. */
  available: boolean;
  /** The subset of `weights` the family actually ships. */
  availableWeights: number[];
  /** Weights that were asked for and are not available. */
  missingWeights: number[];
}

/**
 * One lookup per family per process. The catalogue does not change during a
 * deck build, and the curator asks about the same handful of families while it
 * narrows down a choice.
 */
const cache = new Map<string, CheckGoogleFontOutput>();

function cacheKey(family: string, weights: number[]): string {
  return `${family.toLowerCase()}|${[...weights].sort((a, b) => a - b).join(',')}`;
}

/** `Playfair Display` → `Playfair+Display`, which is what css2 expects. */
function encodeFamily(family: string): string {
  return family.trim().replace(/\s+/g, '+');
}

async function hostsFamilyAtWeight(family: string, weight: number): Promise<boolean> {
  const url = `${CSS2_URL}?family=${encodeFamily(family)}:wght@${weight}`;

  // css2 varies its response by User-Agent to serve woff2 vs ttf. Any modern
  // UA is fine; omitting one entirely gets a legacy stylesheet back.
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lumina-deck-pro/1.0)' },
  });

  if (response.status === 400 || response.status === 404) return false;

  if (!response.ok) {
    throw new AgentError(
      `Google Fonts lookup for "${family}" failed with ${response.status}`,
      'GOOGLE_FONT_LOOKUP_FAILED',
      'check-google-font',
    );
  }

  return true;
}

export const checkGoogleFont: Tool<CheckGoogleFontInput, CheckGoogleFontOutput> = {
  name: 'check_google_font',
  description:
    'Verifies that Google Fonts hosts a family, and which of the requested weights it ships. Use it before naming any font in a FontPlan.',

  async execute({ family, weights }) {
    const wanted = weights?.length ? weights : DEFAULT_WEIGHTS;
    const key = cacheKey(family, wanted);

    const hit = cache.get(key);
    if (hit) return hit;

    const results = await Promise.all(
      wanted.map(async (weight) => ({ weight, ok: await hostsFamilyAtWeight(family, weight) })),
    );

    const availableWeights = results.filter((r) => r.ok).map((r) => r.weight);

    const output: CheckGoogleFontOutput = {
      family: family.trim(),
      available: availableWeights.length > 0,
      availableWeights,
      missingWeights: results.filter((r) => !r.ok).map((r) => r.weight),
    };

    cache.set(key, output);
    return output;
  },
};
