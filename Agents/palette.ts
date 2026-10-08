import 'server-only';

import sharp from 'sharp';

import type { StyleSpec } from './types';

/**
 * Pulls a generated image into the deck's palette.
 *
 * The image prompt asks for the palette and forbids everything else, and image
 * models mostly comply — right up until the subject has a conventional colour.
 * Ask for a pond in a navy-and-amber deck and you get green, every time, because
 * ponds are green and a negative instruction is the weakest kind there is.
 *
 * One stray hue is all it takes: eleven slides in the deck's colours and one
 * with foliage green in it reads as a mistake, and it is the first thing anyone
 * notices. So the palette is enforced here rather than requested there.
 *
 * ## How
 *
 * Luminance is preserved and hue is replaced. Every pixel's brightness picks a
 * colour from a ramp built out of the deck's own palette, and the result is
 * blended back over the original at `strength`. At 0 nothing happens; at 1 the
 * image is a pure duotone of the deck's colours; in between — where the default
 * sits — form, shading and detail all survive while stray hues are pulled into
 * the family.
 *
 * Deterministic and free: no model, no randomness, no second API call. The same
 * image and the same StyleSpec always produce the same output, which is the
 * same property `styleEnvelope` has and for the same reason.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Rec. 709 luma — the standard weighting for perceived brightness. */
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;

  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * A 256-entry brightness → colour ramp built from the deck's palette.
 *
 * The palette's own colours, sorted dark to light and interpolated between.
 * Anchored at true black and true white so the darkest and brightest pixels in
 * an image are not clipped to the palette's own extremes — an illustration
 * whose highlights all flatten to the deck's lightest grey loses its shape.
 */
export function paletteRamp(spec: StyleSpec): Uint8Array {
  const colors = Object.values(spec.colors)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(parseHex)
    .filter((value): value is Rgb => value !== null);

  const stops = [{ r: 0, g: 0, b: 0 }, ...colors, { r: 255, g: 255, b: 255 }]
    .map((color) => ({ color, at: luminance(color) }))
    .sort((a, b) => a.at - b.at);

  const ramp = new Uint8Array(256 * 3);

  for (let level = 0; level < 256; level++) {
    // The pair of stops this brightness falls between.
    let upper = stops.findIndex((stop) => stop.at >= level);
    if (upper === -1) upper = stops.length - 1;
    const lower = Math.max(0, upper - 1);

    const from = stops[lower];
    const to = stops[upper];
    const span = to.at - from.at;
    const t = span <= 0 ? 0 : (level - from.at) / span;

    ramp[level * 3] = Math.round(from.color.r + (to.color.r - from.color.r) * t);
    ramp[level * 3 + 1] = Math.round(from.color.g + (to.color.g - from.color.g) * t);
    ramp[level * 3 + 2] = Math.round(from.color.b + (to.color.b - from.color.b) * t);
  }

  return ramp;
}

/**
 * Blends `png` toward the deck's palette and returns PNG bytes.
 *
 * Never throws: an image that cannot be harmonised is returned untouched. A
 * slightly off-palette picture is a cosmetic problem; losing the picture over
 * a colour-management step is a real one.
 */
export async function harmonise(
  png: Buffer,
  spec: StyleSpec,
  strength: number,
): Promise<Buffer> {
  if (strength <= 0) return png;

  const mix = Math.min(1, strength);
  const keep = 1 - mix;

  try {
    const ramp = paletteRamp(spec);
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const level = Math.min(255, Math.max(0, Math.round(luminance({ r, g, b }))));
      const offset = level * 3;

      data[i] = Math.round(r * keep + ramp[offset] * mix);
      data[i + 1] = Math.round(g * keep + ramp[offset + 1] * mix);
      data[i + 2] = Math.round(b * keep + ramp[offset + 2] * mix);
    }

    return await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return png;
  }
}
