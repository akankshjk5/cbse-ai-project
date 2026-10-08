import type { StyleSpec } from './types';

/**
 * The image prompt, as JSON.
 *
 * A deck's illustrations have to look like one another. Prose prompting cannot
 * deliver that: "muted editorial palette, soft geometric shapes" rewritten
 * twelve times, once per slide, drifts — and the drift is invisible until the
 * deck is open and slide 7 is from a different house style.
 *
 * So the prompt is split in two and only one half is allowed to move.
 *
 * - `style` is derived from the StyleSpec by `styleEnvelope()` and is
 *   **byte-identical for every image in a build**. Nothing in the pipeline
 *   composes it per-slide, and no agent is asked to describe the look. It is
 *   the same object, serialised the same way, in every request.
 * - `subject` is the only part that varies: what this particular picture
 *   shows. That is the field an agent writes, and the field a user can edit
 *   to get a different picture in the same house style.
 *
 * Serialising it as JSON rather than a paragraph is what makes that split
 * legible to the model — the boundary between "the look, fixed" and "the
 * thing, yours" is a brace rather than a comma in the middle of a sentence.
 *
 * ## Why the style block is this detailed
 *
 * An image model given a palette and one adjective invents everything else,
 * and invents it differently each time: line weight, whether there is a
 * horizon, how much of the frame the subject fills, whether it is lit. Those
 * are exactly the properties a viewer reads as "these pictures go together".
 * Naming them costs a few hundred tokens once and is the difference between a
 * deck and a folder of clip art.
 */

/** Locked half of the prompt. Same object for every image in a deck. */
export interface ImageStyleEnvelope {
  version: '2';
  /** Sentence from the StyleSpec describing the deck's overall look. */
  visualLanguage: string;
  /** Role → hex, exactly as extracted from the reference image. */
  palette: Record<string, string>;
  /**
   * The art direction a viewer reads as house style. Derived, not invented —
   * every field is a function of the StyleSpec, so it is identical across a
   * build and changes only when the reference image does.
   */
  direction: {
    medium: string;
    lineWork: string;
    finish: string;
    detail: string;
    lighting: string;
    composition: string;
  };
  /** How pictures are cropped, cornered and bordered in this design system. */
  treatment: {
    crop: 'cover' | 'contain';
    cornerRadiusInches?: number;
    border?: string;
  };
  /** The design system's own rules, as the analyzer stated them. */
  principles: string[];
  /**
   * Never varies and never negotiable. Type is drawn by PowerPoint from real
   * fonts; a model's rendition of lettering is the single most reliable way to
   * make a generated image look generated.
   */
  forbid: string[];
}

/** Varying half. The only part an agent or a user writes. */
export interface ImageSubject {
  /** What the picture shows. Subject and composition only, never style. */
  description: string;
  /** Concrete things that must appear, when the caller knows them. */
  objects?: string[];
  /**
   * What the slide is actually about, in the deck's own words.
   *
   * Relevance, not rendering. A picture chosen from `description` alone is
   * frequently a decorative near-miss — "science" for a slide about
   * condensation — because the description is one line written by a model
   * that had the whole slide in front of it and compressed it to a phrase.
   * Handing over the slide's real heading and message lets the image model
   * pick the specific thing, and `forbid` still stops it drawing the words.
   */
  context?: string;
  /** Where it sits on the slide, which changes how it should be composed. */
  role?: 'background' | 'illustration' | 'spot';
}

export interface ImagePromptInput {
  style: ImageStyleEnvelope;
  subject: ImageSubject;
  output: { width: number; height: number; aspectRatio: string };
}

const FORBIDDEN = [
  'text, letters, words or numbers of any kind, in any language',
  'labels, captions, titles, annotations or hex colour codes written as text',
  'logos, watermarks or signatures',
  'borders, frames or drop shadows around the image',
  'colours outside the stated palette',
  'photographic or 3D-rendered treatment',
  'collage, mixed media, or more than one illustration style in one image',
  'any depiction of a card, poster, document, slide, screen or UI mockup that displays a palette, style guide or these instructions',
];

/** Reads the analyzer's prose for a hint about the medium it described. */
function mediumFor(visualLanguage: string): string {
  const text = visualLanguage.toLowerCase();

  if (/photo|photograph/.test(text)) {
    return 'Editorial photographic composition, colour-graded into the palette below.';
  }
  if (/hand.?drawn|sketch|organic|watercolou?r/.test(text)) {
    return 'Hand-drawn editorial illustration with visible, confident strokes.';
  }
  if (/isometric|3d|dimensional/.test(text)) {
    return 'Clean isometric vector illustration, flat colour with no perspective distortion.';
  }
  return 'Flat vector editorial illustration, in the manner of a broadsheet newspaper’s explanatory graphics.';
}

/**
 * Builds the locked style half from a StyleSpec.
 *
 * Purely derivative: every field is copied or defaulted from the spec, with no
 * model in the loop and no randomness, so calling it twice on the same spec
 * gives the same object. That determinism is the whole feature — it is what
 * lets a caller swap the subject and be confident the look did not move.
 */
export function styleEnvelope(spec: StyleSpec): ImageStyleEnvelope {
  const palette: Record<string, string> = {};
  for (const [role, value] of Object.entries(spec.colors)) {
    if (typeof value === 'string' && value) palette[role] = value;
  }

  return {
    version: '2',
    visualLanguage: spec.visualLanguage,
    palette,
    direction: {
      medium: mediumFor(spec.visualLanguage),
      lineWork:
        'Even, deliberate line weight throughout. Every element in this deck is drawn with the same pen.',
      finish:
        'Flat fills only — no gradients, no noise, no texture overlays, no bevels, no glow.',
      detail:
        'Richly detailed but legible at a glance: build the subject from many clean, distinct shapes rather than a few vague ones, and let every shape be readable at thumbnail size. Detail must clarify the idea, never decorate around it.',
      lighting:
        'Even, ambient, directionless. Shape is described by colour and outline, not by shadow.',
      composition:
        'One clear focal subject, centred weight, generous negative space in the deck’s background colour. No vignetting, no busy corners.',
    },
    treatment: {
      crop: spec.imageTreatment?.cropMode ?? 'cover',
      cornerRadiusInches: spec.imageTreatment?.borderRadius,
      border: spec.imageTreatment?.border,
    },
    // Bounded: the analyzer sometimes returns a dozen, and a prompt that is
    // mostly rules stops being about the picture.
    principles: spec.layoutPrinciples.slice(0, 5),
    forbid: FORBIDDEN,
  };
}

/** Composition note for where the image sits, since that changes the framing. */
function framingFor(subject: ImageSubject, style: ImageStyleEnvelope): string {
  if (subject.role === 'background') {
    return 'Full-bleed backdrop: the slide’s text is laid over this, so keep the centre calm and low-contrast, with any detail toward the edges.';
  }

  if (subject.role === 'spot') {
    return 'A single spot illustration: one object, centred, no scene around it.';
  }

  return style.treatment.crop === 'contain'
    ? 'Keep the subject fully inside the frame with generous margin.'
    : 'Compose for a full-bleed crop — keep the subject clear of the outer 8%.';
}

/**
 * Renders the prompt an image model actually receives.
 *
 * A short instruction header, then the JSON. The header exists because image
 * endpoints take a string: without a line telling the model what the blocks
 * mean, a raw object is just as likely to be read as a caption.
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const { style, subject, output } = input;

  const body = {
    style,
    subject: {
      description: subject.description,
      ...(subject.objects?.length ? { objects: subject.objects } : {}),
      ...(subject.context ? { slideContext: subject.context } : {}),
      role: subject.role ?? 'illustration',
    },
    output: { ...output, format: 'png' },
  };

  return [
    'ABSOLUTE RULE, before anything else: the finished image must contain ZERO',
    'visible text — no letters, words, numbers, hex codes, labels or captions —',
    'and must not depict a card, poster, document or UI showing a palette or',
    'style guide. This is a standalone illustration, not a picture of a spec sheet.',
    '',
    'Generate one image from the specification below. It is generation parameters',
    'for you to interpret, not content: never render any of its field names,',
    'values, prose or hex codes as visible glyphs in the image.',
    '',
    'The `style` block is fixed for this entire presentation — every image in the',
    'deck is generated from exactly this block, so reproduce its palette, medium',
    'and art direction precisely and do not reinterpret them. Two images from this',
    'deck placed side by side must look like the work of one illustrator.',
    '',
    'The `subject` block is what THIS image depicts, and is the only thing that',
    'differs from the others. `slideContext` is what the slide it belongs to says:',
    'use it to choose a specific, accurate subject rather than a generic one —',
    'but never draw those words, or any words, into the picture.',
    '',
    JSON.stringify(body, null, 2),
    '',
    framingFor(subject, style),
    `Fill the frame at ${output.width}x${output.height} pixels (${output.aspectRatio}).`,
    `The background must read as ${style.palette.background ?? 'the deck background'} so the image sits flush on the slide.`,
    '',
    'Final reminder: no text, letters, numbers or hex codes anywhere in the image.',
  ].join('\n');
}
