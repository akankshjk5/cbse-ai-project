import 'server-only';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serverEnv } from '@/lib/env';
import type { ImageSize } from '../images';
import { generateImageTool } from './generate-image';
import type { SlideSpec, StyleSpec } from '../types';

/**
 * Fills in the pictures a deck asks for.
 *
 * The Slide Designer says *what* each image should show (`imagePrompt`) and
 * how big a hole it has to fill (`box`, in inches). This turns that into an
 * actual PNG on disk and points `imagePath` at it — which is what the builder
 * needs, and what no model can supply on its own.
 *
 * Nothing here is allowed to fail a deck. An image that will not generate is
 * dropped from its slide: a deck with one missing illustration is a deck; a
 * build that dies at the last stage over a picture is nothing.
 */

/**
 * The resolution to ask for, at print density.
 *
 * A ceiling rather than a promise: `generateImage` will not enlarge past what
 * the model actually returned (about a megapixel, whatever it is asked for),
 * so a number this high simply means "use all the detail there is". A small
 * spot illustration gets a crisp downsample of the full frame; a half-slide
 * hero gets the native image at the box's exact aspect ratio.
 */
const PIXELS_PER_INCH = 300;
const MIN_EDGE = 256;
const MAX_EDGE = 4096;

function sizeForBox(box: { w: number; h: number }): ImageSize {
  const clamp = (inches: number) =>
    Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.round(inches * PIXELS_PER_INCH)));

  return { width: clamp(box.w), height: clamp(box.h) };
}

/**
 * What the slide this picture belongs to actually says.
 *
 * The designer's `imagePrompt` is one phrase, written while compressing a
 * whole slide — which is how a slide about condensation ends up illustrated
 * with a generic beaker. Handing the image model the slide's real heading and
 * copy lets it choose the specific thing instead. The style block's `forbid`
 * list is what stops it drawing the words themselves.
 */
function contextOf(slide: SlideSpec): string {
  const copy = slide.elements
    .filter((element) => element.type !== 'image')
    .flatMap((element) => [element.text, ...(element.items ?? [])]);

  return [slide.title, slide.subtitle, ...copy]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' · ')
    .slice(0, 600);
}

export interface IllustrateResult {
  slideSpecs: SlideSpec[];
  /** Absolute paths of every image written, for the caller to upload. */
  generated: string[];
  /** One line per image that could not be made. */
  failures: string[];
}

/**
 * Generates every `image` element's picture and rewrites `imagePath`.
 *
 * Images are generated concurrently per slide but slides run in order, so a
 * deck of twelve does not open twelve provider connections at once.
 */
export async function illustrateSlides(
  slideSpecs: SlideSpec[],
  styleSpec: StyleSpec,
  outputDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IllustrateResult> {
  const targets = slideSpecs.flatMap((slide) =>
    slide.elements
      .map((element, index) => ({ slide, element, index }))
      .filter(({ element }) => element.type === 'image' && !element.imagePath),
  );

  if (targets.length === 0) return { slideSpecs, generated: [], failures: [] };

  // `OPENROUTER_IMAGE_TIER=off` means a text-only deck, not a broken one.
  if (!serverEnv.imagesEnabled) {
    return {
      slideSpecs: dropImageElements(slideSpecs),
      generated: [],
      failures: ['Image generation is disabled (OPENROUTER_IMAGE_TIER=off)'],
    };
  }

  await mkdir(outputDir, { recursive: true });

  const generated: string[] = [];
  const failures: string[] = [];
  let done = 0;

  for (const { slide, element } of targets) {
    // A picture with nothing to depict is the designer asking for decoration.
    // Fall back to the slide's own subject rather than inventing one.
    const prompt =
      element.imagePrompt ??
      [slide.title, slide.subtitle, element.text].filter(Boolean).join(' — ');

    if (!prompt) {
      failures.push(`Slide ${slide.slideNumber}: image element with nothing to depict`);
      continue;
    }

    try {
      const image = await generateImageTool.execute({
        prompt,
        size: sizeForBox(element.box),
        styleSpec,
        context: contextOf(slide),
        role: element.box.w * element.box.h < 4 ? 'spot' : 'illustration',
      });

      const file = path.join(outputDir, `slide-${slide.slideNumber}-${element.role}.png`);
      await writeFile(file, Buffer.from(image.base64, 'base64'));

      element.imagePath = file;
      generated.push(file);
    } catch (error) {
      failures.push(
        `Slide ${slide.slideNumber} (${element.role}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      done += 1;
      onProgress?.(done, targets.length);
    }
  }

  // Anything still without a file would throw in the builder — drop it here,
  // where the reason is known and the deck can still be finished.
  return {
    slideSpecs: backfillEmptySlides(dropImageElements(slideSpecs, true), styleSpec),
    generated,
    failures,
  };
}

/** Removes image elements, or only the ones that never got a file. */
function dropImageElements(slideSpecs: SlideSpec[], onlyUnresolved = false): SlideSpec[] {
  return slideSpecs.map((slide) => ({
    ...slide,
    elements: slide.elements.filter(
      (element) =>
        element.type !== 'image' || (onlyUnresolved && Boolean(element.imagePath)),
    ),
  }));
}

/**
 * Gives a slide back its title when dropping an image emptied it.
 *
 * The builder draws elements and nothing else — `slide.title` is metadata to
 * it. So a slide whose only element was a failed illustration would come out as
 * a blank page in the middle of the deck, which is worse than a slide that
 * simply has no picture.
 */
function backfillEmptySlides(slideSpecs: SlideSpec[], styleSpec: StyleSpec): SlideSpec[] {
  const margin = styleSpec.spacing.outerMargin;
  const width = styleSpec.slideSize.width - margin * 2;

  return slideSpecs.map((slide) => {
    if (slide.elements.length > 0) return slide;

    const heading = slide.title ?? slide.subtitle;
    if (!heading) return slide;

    return {
      ...slide,
      elements: [
        {
          type: 'text' as const,
          role: 'title',
          box: { x: margin, y: margin, w: width, h: 1.5 },
          text: heading,
        },
      ],
    };
  });
}
