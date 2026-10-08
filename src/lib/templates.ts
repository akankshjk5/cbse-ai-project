import { SLIDE_SIZES, type StyleSpec } from '@agents/types';

/**
 * Built-in deck templates.
 *
 * A deck needs a design system before a single slide can be written, and until
 * now the only way to get one was to upload a picture and pay a vision model to
 * read it. That is the right answer when someone has a look they need matched.
 * It is a poor answer for "I want a decent deck": the user has to find an image
 * first, the result is only as consistent as the analyzer's reading of it, and
 * two decks made from two screenshots of the same product do not match each
 * other.
 *
 * A template is the same `StyleSpec` the analyzer would produce, written out by
 * hand and known to be good. Picking one is therefore not a downgrade from the
 * reference-image path — it is the same contract, filled in with values that
 * have been checked rather than inferred:
 *
 *  - every text/background pair here clears WCAG AA, so `readableOn` never has
 *    to substitute a colour and the deck ships the palette it was given;
 *  - every size is already above `MIN_TYPE_SIZES`, so `legibleSizes` has
 *    nothing to lift and the hierarchy survives exactly as written;
 *  - the families are real Google Fonts, so `font-curator` confirms rather
 *    than repairs them;
 *  - `visualLanguage` is read verbatim into every image prompt for the deck,
 *    so it is written as usable art direction — medium, finish, light — not as
 *    an adjective.
 *
 * It also skips the style-analyzer call and its critic entirely, which is the
 * one stage that has to send an image to a vision model.
 *
 * `slideSize` and `source` are filled in by the Manager, exactly as they are
 * for an analyzed spec — dimensions are never left to a definition either.
 */

export const TEMPLATE_IDS = [
  'classroom-slate',
  'chalk-and-paper',
  'bright-minimal',
  'solar-field',
  'midnight-lab',
  'coral-sunrise',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface DeckTemplate {
  id: TemplateId;
  /** Shown on the picker tile. */
  name: string;
  /** One line on the tile: what this template is FOR, not what colour it is. */
  description: string;
  /** Three swatches for the tile, background first. */
  swatches: [string, string, string];
  /** Everything but `slideSize` and `source`, which the Manager owns. */
  style: Omit<StyleSpec, 'slideSize' | 'source'>;
}

/** Shared rhythm. Only a template with a reason to differ overrides it. */
const SPACING = {
  outerMargin: 0.55,
  sectionGap: 0.34,
  elementGap: 0.2,
  paragraphGap: 0.13,
} as const;

/**
 * Shared type scale, in points.
 *
 * Above `MIN_TYPE_SIZES` at every step and roughly a 2.2:1 title-to-body
 * ratio, which is the conventional presentation hierarchy: large enough to
 * read from the back of a room, not so large that a two-line heading eats the
 * slide.
 */
const SCALE = {
  title: { size: 40, weight: 700 },
  subtitle: { size: 23, weight: 400 },
  body: { size: 19, weight: 400 },
  caption: { size: 15, weight: 400 },
} as const;

export const DECK_TEMPLATES: Record<TemplateId, DeckTemplate> = {
  'classroom-slate': {
    id: 'classroom-slate',
    name: 'Classroom Slate',
    description: 'Deep slate blue with warm amber. Reads well on a projector in a lit room.',
    swatches: ['#2c4450', '#f2f6f7', '#e8a33d'],
    style: {
      version: '1',
      colors: {
        background: '#2c4450',
        surface: '#365360',
        primaryText: '#f4f8f9',
        secondaryText: '#c3d3d9',
        accent: '#e8a33d',
        accentSecondary: '#7fc4b8',
        border: '#4d6b78',
      },
      typography: {
        headingFont: 'Poppins',
        bodyFont: 'Inter',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
      },
      spacing: { ...SPACING },
      shapes: { cornerRadius: 0.1, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.12, cropMode: 'cover' },
      visualLanguage:
        'Editorial vector illustration on a flat slate-blue field. Clean geometric shapes with a single warm amber highlight per image, soft even lighting, no gradients beyond a gentle two-tone shade, generous negative space, no outlines thinner than the stroke of the shapes themselves.',
      layoutPrinciples: [
        'One idea per slide, stated in the heading.',
        'The illustration takes the larger half of the canvas; the copy sits beside it.',
        'Amber is used once per slide, on the thing that matters most.',
        'Wide outer margins; nothing runs to the edge except a full-bleed picture.',
      ],
    },
  },

  'chalk-and-paper': {
    id: 'chalk-and-paper',
    name: 'Chalk & Paper',
    description: 'Warm paper, ink serif headings, terracotta accents. Bookish and calm.',
    swatches: ['#f6f1e7', '#1f2b3a', '#c0603a'],
    style: {
      version: '1',
      colors: {
        background: '#f6f1e7',
        surface: '#efe7d8',
        primaryText: '#1f2b3a',
        secondaryText: '#5a6472',
        accent: '#c0603a',
        accentSecondary: '#3f6f5f',
        border: '#ddd2bd',
      },
      typography: {
        headingFont: 'Playfair Display',
        bodyFont: 'Source Sans 3',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
        title: { size: 42, weight: 700 },
      },
      spacing: { ...SPACING, sectionGap: 0.38 },
      shapes: { cornerRadius: 0.04, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.04, cropMode: 'cover' },
      visualLanguage:
        'Hand-inked textbook illustration on warm cream paper. Fine confident linework, flat washes of terracotta and muted green, visible paper grain, natural daylight, the look of a well-printed reference book rather than a poster.',
      layoutPrinciples: [
        'A single column of prose reads from one left edge.',
        'Headings are set in the serif; everything else in the sans.',
        'Terracotta marks emphasis; green marks a second, subordinate thread.',
        'Rules and borders are hairlines, never boxes.',
      ],
    },
  },

  'bright-minimal': {
    id: 'bright-minimal',
    name: 'Bright Minimal',
    description: 'White, near-black type, one indigo accent. Gets out of the picture’s way.',
    swatches: ['#ffffff', '#111318', '#4338ca'],
    style: {
      version: '1',
      colors: {
        background: '#ffffff',
        surface: '#f4f5f7',
        primaryText: '#111318',
        secondaryText: '#4d525c',
        accent: '#4338ca',
        accentSecondary: '#0f766e',
        border: '#e2e4e9',
      },
      typography: {
        headingFont: 'Inter',
        bodyFont: 'Inter',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
        title: { size: 44, weight: 700 },
      },
      spacing: { ...SPACING, outerMargin: 0.6 },
      shapes: { cornerRadius: 0.08, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.08, cropMode: 'cover' },
      visualLanguage:
        'Bright isometric illustration on white. Soft matte surfaces, a restrained indigo and teal palette, light from the upper left with gentle contact shadows, no texture and no outline — the subject reads by its own form.',
      layoutPrinciples: [
        'Whitespace is the design; nothing is added to fill it.',
        'One accent colour, used sparingly.',
        'Type does the hierarchy — no rules, no boxes, no shading.',
        'The picture is the loudest thing on the slide.',
      ],
    },
  },

  'solar-field': {
    id: 'solar-field',
    name: 'Solar Field',
    description: 'Cream and deep green with mustard. Warm, for science and nature topics.',
    swatches: ['#fdf6e8', '#1e3d2f', '#d99e2b'],
    style: {
      version: '1',
      colors: {
        background: '#fdf6e8',
        surface: '#f3e9d3',
        primaryText: '#1e3d2f',
        secondaryText: '#4f6a5b',
        accent: '#b8761a',
        accentSecondary: '#2f6f8f',
        border: '#e0d3b4',
      },
      typography: {
        headingFont: 'Fraunces',
        bodyFont: 'Nunito Sans',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
      },
      spacing: { ...SPACING },
      shapes: { cornerRadius: 0.14, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.14, cropMode: 'cover' },
      visualLanguage:
        'Warm gouache-style natural illustration on cream. Layered greens and ochres, soft brush edges, sunlight from one side with long gentle shadows, botanical-plate accuracy in the shapes without any labelling.',
      layoutPrinciples: [
        'Rounded corners throughout; nothing is sharp.',
        'Deep green carries the text, ochre carries the emphasis.',
        'Pictures are given room to breathe rather than cropped tight.',
        'Two columns at most; three is a list, not a layout.',
      ],
    },
  },

  'midnight-lab': {
    id: 'midnight-lab',
    name: 'Midnight Lab',
    description: 'Near-black with cyan and violet. For technical and computing topics.',
    swatches: ['#0e1116', '#e8ecf2', '#3ad2c8'],
    style: {
      version: '1',
      colors: {
        background: '#0e1116',
        surface: '#1a2029',
        primaryText: '#e8ecf2',
        secondaryText: '#9aa6b6',
        accent: '#3ad2c8',
        accentSecondary: '#a78bfa',
        border: '#2a3341',
      },
      typography: {
        headingFont: 'Space Grotesk',
        bodyFont: 'IBM Plex Sans',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
      },
      spacing: { ...SPACING, outerMargin: 0.5 },
      shapes: { cornerRadius: 0.06, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.06, cropMode: 'cover' },
      visualLanguage:
        'Dark technical illustration lit from within. Deep near-black ground, luminous cyan and violet edges, precise geometric forms with a faint volumetric glow, high contrast and no ambient clutter — the look of an instrument panel rather than a neon sign.',
      layoutPrinciples: [
        'High contrast: bright type on a dark ground, never mid-grey on mid-grey.',
        'Cyan is structure, violet is emphasis; nothing else is coloured.',
        'Surfaces are a step lighter than the ground, never outlined and filled at once.',
        'Dense information is split across slides rather than shrunk.',
      ],
    },
  },

  'coral-sunrise': {
    id: 'coral-sunrise',
    name: 'Coral Sunrise',
    description: 'Soft blush and plum with coral. Friendly, for younger classes.',
    swatches: ['#fff5f2', '#3d2545', '#e2674f'],
    style: {
      version: '1',
      colors: {
        background: '#fff5f2',
        surface: '#ffe9e2',
        primaryText: '#3d2545',
        secondaryText: '#6b5570',
        accent: '#c94f36',
        accentSecondary: '#3f7d8c',
        border: '#f4d6cc',
      },
      typography: {
        headingFont: 'Outfit',
        bodyFont: 'Karla',
        headingFontFallbacks: [],
        bodyFontFallbacks: [],
        ...SCALE,
        title: { size: 42, weight: 700 },
      },
      spacing: { ...SPACING, paragraphGap: 0.15 },
      shapes: { cornerRadius: 0.18, borderWidth: 0.01 },
      imageTreatment: { borderRadius: 0.18, cropMode: 'cover' },
      visualLanguage:
        'Friendly cut-paper collage illustration. Simple rounded shapes in blush, coral and teal layered with soft drop shadows, matte paper texture, even front lighting, cheerful without being childish.',
      layoutPrinciples: [
        'Generously rounded shapes; nothing has a hard corner.',
        'Coral for emphasis, teal for a second thread, plum for all text.',
        'Short lines: no more than two or three points on a slide.',
        'The illustration is the friendliest thing on the slide, and the largest.',
      ],
    },
  },
};

export const DEFAULT_TEMPLATE_ID: TemplateId = 'classroom-slate';

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * A template as a complete `StyleSpec`, ready to be stored on the deck.
 *
 * The canvas is fixed here for the same reason `analyzeStyle` overwrites it on
 * an analyzed spec: PowerPoint has two conventional sizes and neither a model
 * nor a template definition gets a vote. `source.path` records which template
 * this was, which is what lets a rebuild reuse it instead of reaching for a
 * reference image that was never uploaded.
 */
export function templateStyleSpec(id: TemplateId): StyleSpec {
  const template = DECK_TEMPLATES[id];

  return {
    ...template.style,
    slideSize: { ...SLIDE_SIZES['16:9'], aspectRatio: '16:9' },
    source: { type: 'template', path: id },
  };
}
