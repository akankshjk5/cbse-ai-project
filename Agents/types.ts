import { z } from 'zod';

import { motionSchema } from './motion';
import { LAYOUT_ARCHETYPES, LAYOUT_SLOTS } from './pptx/layouts';

/**
 * Domain models for the deck-generation pipeline, defined as Zod schemas so
 * model output can be validated before it reaches the next stage. The
 * TypeScript types are inferred from the schemas — never declared separately,
 * or the two drift apart silently.
 */

/**
 * The handful of CSS colour names a model reaches for when describing a
 * palette. Not the full list of 148 — those are the ones worth spelling out,
 * and an exotic name is a sign the model is guessing rather than reading.
 */
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  transparent: '#ffffff',
};

function toHex(component: string): string {
  return Math.max(0, Math.min(255, Math.round(Number(component))))
    .toString(16)
    .padStart(2, '0');
}

/**
 * A colour, normalised to `#rrggbb`.
 *
 * The colour fields are REQUIRED, so anything the schema will not take is
 * fatal to the build — and `#fff`, `rgb(17, 24, 39)` and `white` are all
 * perfectly good answers to "what colour is the background". Normalise the
 * shapes a model actually produces; a colour that cannot be read still fails.
 */
const hexColor = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const text = value.trim().toLowerCase();

  if (NAMED_COLORS[text]) return NAMED_COLORS[text];

  // #abc → #aabbcc
  const short = text.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;

  // rgb(17, 24, 39) / rgba(17, 24, 39, 0.5) — alpha is dropped, PowerPoint
  // carries transparency on the shape, not in the colour.
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`;

  // Bare rrggbb, no hash.
  if (/^[0-9a-f]{6}$/.test(text)) return `#${text}`;

  return text;
}, z.string().regex(/^#[0-9a-f]{6}$/, 'expected a #rrggbb hex color'));

/**
 * A measurement the model may have written with its unit attached.
 *
 * Asking for "font sizes in points, spacing in inches" reliably produces some
 * `"44pt"` and `"0.5in"` among the numbers. That is the model answering the
 * question correctly in a shape the schema did not ask for, and rejecting it
 * costs a retry — and sometimes the whole deck — over a suffix. Strip the unit
 * and move on; anything genuinely non-numeric still fails.
 */
const measurement = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const stripped = value.trim().replace(/(px|pt|in|inch|inches|em|rem|%)$/i, '');
    const parsed = Number(stripped);
    return Number.isNaN(parsed) ? value : parsed;
  }, schema);

/** CSS weight names, since a model reading an image thinks in words. */
const FONT_WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/**
 * A font weight as 100-900.
 *
 * The style analyzer looks at letterforms, so it answers "bold" far more often
 * than "700" — and the PPTX builder needs the number. Mapping the vocabulary
 * here beats spending a retry teaching it the CSS scale every single build.
 */
const fontWeight = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const word = FONT_WEIGHT_WORDS[value.toLowerCase().replace(/[\s_-]/g, '')];
  if (word !== undefined) return word;

  const parsed = Number(value.trim());
  return Number.isNaN(parsed) ? value : parsed;
}, z.number().int().min(100).max(900));

// ── StyleSpec ────────────────────────────────────────────────────────────────

export const styleSpecSchema = z.object({
  version: z.string().default('1'),
  /**
   * Where this design system came from.
   *
   * `image` — a reference the style analyzer looked at; `path` is the file it
   * read. `template` — one of the built-in presets in `src/lib/templates.ts`,
   * chosen by the user instead of uploading anything; `path` is the template
   * id. The distinction is load-bearing on a rebuild: an image deck is
   * re-analyzed from its reference, a template deck reuses the preset
   * verbatim and makes no vision call at all.
   */
  source: z.object({
    type: z.enum(['image', 'template']),
    path: z.string(),
  }),
  slideSize: z.object({
    width: measurement(z.number().positive()),
    height: measurement(z.number().positive()),
    aspectRatio: z.enum(['16:9', '4:3', 'custom']),
  }),
  colors: z.object({
    background: hexColor,
    surface: hexColor.optional(),
    primaryText: hexColor,
    secondaryText: hexColor.optional(),
    accent: hexColor.optional(),
    accentSecondary: hexColor.optional(),
    border: hexColor.optional(),
  }),
  typography: z.object({
    headingFont: z.string(),
    bodyFont: z.string(),
    /**
     * Filled in by the Font Curator after the style analyzer's estimate, never
     * by the analyzer itself — see fontPlanSchema. Empty until that stage runs.
     */
    headingFontFallbacks: z.array(z.string()).default([]),
    bodyFontFallbacks: z.array(z.string()).default([]),
    title: z.object({
      size: measurement(z.number().positive()),
      weight: fontWeight,
      casing: z.string().optional(),
    }),
    subtitle: z
      .object({ size: measurement(z.number().positive()), weight: fontWeight })
      .optional(),
    body: z.object({ size: measurement(z.number().positive()), weight: fontWeight }),
    caption: z
      .object({ size: measurement(z.number().positive()), weight: fontWeight })
      .optional(),
  }),
  /**
   * Spacing, in inches. Every field has a default because a model asked for
   * four gaps routinely returns three — and a missing `elementGap` is not worth
   * failing a deck over when a sane rhythm is one line of code away. Anything
   * the analyzer DOES report still wins; the defaults only fill silence.
   */
  spacing: z
    .object({
      outerMargin: measurement(z.number().nonnegative()).default(0.5),
      sectionGap: measurement(z.number().nonnegative()).default(0.35),
      elementGap: measurement(z.number().nonnegative()).default(0.2),
      paragraphGap: measurement(z.number().nonnegative()).default(0.12),
    })
    // prefault, not default: `{}` is fed THROUGH the object so each field's own
    // default applies. `.default({})` would have to restate all four values.
    .prefault({}),
  /**
   * Cosmetic detail, and `.catch()` on purpose.
   *
   * Nothing downstream depends on these blocks — every consumer already
   * falls back (`spec.shapes.cornerRadius ?? 0`, `imageTreatment?.cropMode`).
   * They are the parts of the spec a model is most inventive about, and losing
   * an entire deck over a stray `border: false` is a bad trade. A block that
   * does not parse is dropped; the required structure above still fails loudly.
   */
  shapes: z
    .object({
      cornerRadius: measurement(z.number().nonnegative()).optional(),
      borderWidth: measurement(z.number().nonnegative()).optional(),
      shadow: z
        .object({
          enabled: z.boolean(),
          blur: measurement(z.number()).optional(),
          opacity: measurement(z.number()).optional(),
        })
        .optional(),
    })
    .default({})
    .catch({}),
  imageTreatment: z
    .object({
      borderRadius: measurement(z.number()).optional(),
      /**
       * A description like "1px solid #e5e7eb". Asked whether images have a
       * border, a model often answers the question rather than the field and
       * returns a boolean — `false` means none, `true` means one it did not
       * describe.
       */
      border: z
        .preprocess(
          (value) => (typeof value === 'boolean' ? (value ? 'solid' : undefined) : value),
          z.string().optional(),
        )
        .optional(),
      cropMode: z.enum(['cover', 'contain']).optional(),
    })
    .optional()
    .catch(undefined),
  visualLanguage: z.string(),
  layoutPrinciples: z.array(z.string()),
});

export type StyleSpec = z.infer<typeof styleSpecSchema>;

/**
 * Slide canvas, in inches. Not something the model gets a vote on: PowerPoint
 * has exactly two conventional canvases, and a hallucinated 12.7x7.1 would put
 * every box the designer places slightly off the slide.
 */
export const SLIDE_SIZES = {
  '16:9': { width: 13.333, height: 7.5 },
  '4:3': { width: 10, height: 7.5 },
} as const;

export type SlideAspectRatio = keyof typeof SLIDE_SIZES;

// ── FontPlan ─────────────────────────────────────────────────────────────────

/**
 * The Font Curator's output: the estimated typefaces from the reference image,
 * resolved to families that actually exist, each with a fallback chain.
 *
 * PowerPoint has no CSS-style font stack — it names one typeface and silently
 * substitutes Calibri when the machine lacks it. So the chain is resolved here,
 * before the deck is built, rather than left to the renderer.
 */
const fontChoiceSchema = z.object({
  /** Google Fonts family name, spelled as Google spells it. */
  family: z.string().min(1),
  /** Weights the deck will use. Must be weights the family actually ships. */
  weights: z.array(fontWeight).min(1),
  /**
   * Ordered fallbacks, most-similar first, ending in a font every machine has
   * (Arial, Georgia, Courier New). Never a Google-only family.
   */
  fallbacks: z.array(z.string().min(1)).min(1),
  /** What in the reference image led here. Keeps the choice auditable. */
  rationale: z.string().min(1),
});

export const fontPlanSchema = z.object({
  heading: fontChoiceSchema,
  body: fontChoiceSchema,
});

export type FontChoice = z.infer<typeof fontChoiceSchema>;
export type FontPlan = z.infer<typeof fontPlanSchema>;

// ── ContentPlan ──────────────────────────────────────────────────────────────

/**
 * Words a slide may carry, when nobody says otherwise.
 *
 * A slide is not a page. Left unconstrained a language model writes prose,
 * the designer dutifully lays that prose out, and the overflow checker then
 * reports a text box twice the height of the canvas — three stages of work to
 * discover the copy was too long. The budget is decided at planning time and
 * enforced before anything is designed.
 *
 * 55, not 85. Every slide in this pipeline is guaranteed a picture, and the
 * picture is given the larger share of a hero layout (`HERO_IMAGE_SHARE`) —
 * which only pays off if the copy beside it is short enough that the slide
 * reads as an illustrated point rather than a paragraph with a photo next to
 * it. 85 was set when the worry was slides of bare labels; `MIN_BUDGET_USE`
 * now guards that end of the range, so the ceiling is free to come down to
 * what a person can actually read off a projected slide.
 */
export const DEFAULT_WORD_BUDGET = 55;
export const TITLE_WORD_BUDGET = 14;

/**
 * The share of its budget a slide is expected to actually use.
 *
 * The budget was built as a ceiling, and a ceiling on its own produces the
 * opposite failure: a designer that writes "Following a recipe" in a card and
 * moves on is comfortably inside 60 words and has said nothing. Three
 * three-word labels is not a slide, it is a list of headings.
 *
 * So the budget is a range. Below this fraction the slide is under-written and
 * the QA pass says so, in the same voice and with the same authority as the
 * over-budget check — both are counted, neither is a matter of taste.
 */
export const MIN_BUDGET_USE = 0.5;

/** Where a slide sits in the narrative. Every deck opens and closes. */
export const SLIDE_SECTIONS = ['intro', 'body', 'conclusion'] as const;
export type SlideSection = (typeof SLIDE_SECTIONS)[number];

export const contentPlanSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  audience: z.string().optional(),
  /**
   * The deck's own ceiling. Individual slides may ask for less; the Manager
   * clamps any that ask for more, because a planner that grants itself an
   * extra fifty words is the failure this field exists to prevent.
   */
  maxWordsPerSlide: measurement(z.number().int().positive()).default(DEFAULT_WORD_BUDGET),
  slides: z
    .array(
      z.object({
        number: z.number().int().positive(),
        /**
         * Defaulted rather than required: a planner that omits it has still
         * produced a usable plan, and the Manager repairs the sequence
         * afterwards so the deck always opens and closes properly.
         */
        section: z.enum(SLIDE_SECTIONS).default('body'),
        purpose: z.string().min(1),
        keyMessage: z.string().min(1),
        content: z.array(z.string()),
        /** Max words of on-slide copy for THIS slide, title included. */
        wordBudget: measurement(z.number().int().positive()).default(DEFAULT_WORD_BUDGET),
        recommendedVisual: z.string().optional(),
      }),
    )
    .min(1),
});

export type ContentPlan = z.infer<typeof contentPlanSchema>;

// ── SlideSpec ────────────────────────────────────────────────────────────────

export const SLIDE_LAYOUTS = [
  'title',
  'section',
  'single-column',
  'two-column',
  'three-column',
  'comparison',
  'timeline',
  'process',
  'data',
  'quote',
  'closing',
  'custom',
] as const;

/** Where an element sits on the slide, in inches. */
const boxSchema = z.object({
  x: measurement(z.number()),
  y: measurement(z.number()),
  w: measurement(z.number().positive()),
  h: measurement(z.number().positive()),
});

const ELEMENT_TYPES = [
  'text',
  'image',
  'shape',
  'card',
  'statistic',
  'diagram',
  'chart',
  'divider',
] as const;

/**
 * What a designer calls a thing, mapped to what the builder draws.
 *
 * `type` is the element's RENDERING kind, but a model composing a slide thinks
 * in roles — "this is the title, these are the bullets". Those answers are
 * correct about the deck and wrong about the field, so they are translated
 * rather than rejected, and the role they imply is kept below.
 */
const ELEMENT_TYPE_ALIASES: Record<string, (typeof ELEMENT_TYPES)[number]> = {
  title: 'text',
  heading: 'text',
  subtitle: 'text',
  subheading: 'text',
  body: 'text',
  paragraph: 'text',
  bullets: 'text',
  bullet: 'text',
  list: 'text',
  quote: 'text',
  caption: 'text',
  label: 'text',
  picture: 'image',
  photo: 'image',
  illustration: 'image',
  graphic: 'image',
  icon: 'image',
  stat: 'statistic',
  kpi: 'statistic',
  metric: 'statistic',
  number: 'statistic',
  callout: 'card',
  panel: 'card',
  box: 'card',
  rule: 'divider',
  line: 'divider',
  separator: 'divider',
  graph: 'chart',
  table: 'chart',
};

/** Coordinates a model may have written flat, or under another name. */
function coerceBox(element: Record<string, unknown>): unknown {
  if (element.box) return element.box;

  const position = (element.position ?? element.bounds ?? element.frame) as
    | Record<string, unknown>
    | undefined;
  const size = element.size as Record<string, unknown> | undefined;

  const x = element.x ?? position?.x ?? position?.left;
  const y = element.y ?? position?.y ?? position?.top;
  const w = element.w ?? element.width ?? size?.w ?? size?.width ?? position?.w ?? position?.width;
  const h =
    element.h ?? element.height ?? size?.h ?? size?.height ?? position?.h ?? position?.height;

  // All four or nothing — a half-built box would place content at a guess.
  if ([x, y, w, h].every((value) => value !== undefined)) return { x, y, w, h };
  return undefined;
}

/** An element's frame, in inches on the deck's canvas. */
export type Box = z.infer<typeof boxSchema>;

export const slideElementSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;

  const element = { ...(value as Record<string, unknown>) };

  const declared = typeof element.type === 'string' ? element.type.toLowerCase().trim() : undefined;
  const alias = declared ? ELEMENT_TYPE_ALIASES[declared] : undefined;

  if (alias) {
    element.type = alias;
    // The word it used was a role even if it was filed under `type`, so keep it
    // rather than losing the only hint about which theme size to apply.
    element.role ??= declared;
  }

  element.role ??= typeof element.type === 'string' ? element.type : 'body';
  element.text ??= element.content ?? element.value;
  element.imagePrompt ??= element.prompt ?? element.description ?? element.alt;
  element.items ??= element.bullets ?? element.lines;

  const box = coerceBox(element);
  if (box !== undefined) element.box = box;

  return element;
}, z.object({
  type: z.enum(ELEMENT_TYPES),
  /** Semantic role, e.g. 'title' | 'body' | 'caption' — drives which theme size applies. */
  role: z.string(),
  box: boxSchema,
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  /**
   * What the picture should show, in the designer's words.
   *
   * The Slide Designer describes; the Illustrator generates. A designer cannot
   * know a path that does not exist yet, so asking it for one only ever
   * produced plausible fiction that broke the build.
   */
  imagePrompt: z.string().optional(),
  /**
   * Set by the Illustrator, never by the designer: an absolute path to a file
   * that exists on this machine by the time the builder runs.
   */
  imagePath: z.string().optional(),
  /**
   * How the text sits in its box. Optional, and normally omitted: `placementFor`
   * in ./pptx/theme picks the conventional alignment for the element's role,
   * and both renderers use it. These exist for the slide where that is wrong.
   *
   * `.catch(undefined)` because an unrecognised value should fall back to the
   * sensible default rather than fail a deck over a spelling.
   */
  align: z.enum(['left', 'center', 'right']).optional().catch(undefined),
  valign: z.enum(['top', 'middle', 'bottom']).optional().catch(undefined),
  /**
   * A text-colour preference for this element only, overriding the theme's
   * per-role default (`colorForRole`).
   *
   * Never trusted outright: the builder and `SlideCanvas` both run it through
   * `readableOn` against whatever is actually behind the element — a card's
   * surface, a backdrop's scrim — exactly as the theme's own colours are. A
   * designer asking for a colour that turns out unreadable gets the deck's
   * best substitute instead, the same as it always has; this only widens what
   * "preferred" can mean.
   */
  color: hexColor.optional().catch(undefined),
  /**
   * A fill-colour preference for a `card` or `shape` element, overriding the
   * theme's surface colour. Ignored by every other element type.
   *
   * Not contrast-checked itself — a fill has no text of its own to be
   * unreadable — but `surfaceUnder` resolves it for any element nested inside,
   * so a custom fill still keeps its own contents legible.
   */
  fill: hexColor.optional().catch(undefined),
  /**
   * The role this element plays in its slide's layout archetype.
   *
   * When present, the Manager replaces `box` with the rectangle the archetype
   * assigns — see ./pptx/layouts for why geometry is code's job and not the
   * model's. Absent, the designer's own `box` is used, which is what every
   * slide did before archetypes existed.
   */
  slot: z.enum(LAYOUT_SLOTS).optional().catch(undefined),
  /**
   * The type size this element is actually drawn at, in points.
   *
   * Written by the Manager after measuring the real font (see
   * ./pptx/text-metrics), never by the designer. Both renderers use it rather
   * than deciding for themselves, which is what makes the .pptx and the
   * browser preview agree exactly: the measurement happens once, on the
   * server, with the font file in hand.
   *
   * Absent on decks built before that pass existed; both renderers fall back
   * to the theme size for the element's role.
   */
  fontSize: measurement(z.number().positive()).optional().catch(undefined),
  /**
   * How this element moves when the deck is presented in the browser.
   *
   * The Slide Designer may name an effect and an intensity; `ensureSlideMotion`
   * in the Manager fills in whatever it left out and computes the stagger, so
   * the model chooses *whether and how much* a thing moves and code chooses
   * *when* — the same division as archetypes and geometry.
   *
   * Purely presentational, and deliberately inert everywhere except the live
   * web renderer: it never touches `box`, never reaches the .pptx (PowerPoint
   * animations are not something `pptxgenjs` can write) and is ignored by the
   * rasteriser the visual QA check reads.
   */
  motion: motionSchema.optional().catch(undefined),
}));

export type SlideElement = z.infer<typeof slideElementSchema>;

/**
 * What a designer calls a layout, mapped to one the deck knows.
 *
 * `layout` is metadata — the builder positions everything from element boxes
 * and never reads it (`slide.layout` reaches only the `slides` row, for a
 * future renderer). So an unfamiliar name is a labelling difference, not a
 * broken deck, and the enum already carries `custom` for exactly this. Anything
 * unrecognised lands there rather than costing six good slides.
 */
const LAYOUT_ALIASES: Record<string, (typeof SLIDE_LAYOUTS)[number]> = {
  'title-slide': 'title',
  cover: 'title',
  hero: 'title',
  opening: 'title',
  'section-header': 'section',
  'section-break': 'section',
  chapter: 'section',
  divider: 'section',
  content: 'single-column',
  'title-content': 'single-column',
  'title-and-content': 'single-column',
  'one-column': 'single-column',
  single: 'single-column',
  bullets: 'single-column',
  'bullet-list': 'single-column',
  body: 'single-column',
  text: 'single-column',
  'two-columns': 'two-column',
  split: 'two-column',
  'image-left': 'two-column',
  'image-right': 'two-column',
  'text-image': 'two-column',
  'image-text': 'two-column',
  'image-focus': 'two-column',
  'three-columns': 'three-column',
  compare: 'comparison',
  versus: 'comparison',
  'pros-cons': 'comparison',
  chronology: 'timeline',
  steps: 'process',
  flow: 'process',
  workflow: 'process',
  chart: 'data',
  stats: 'data',
  statistics: 'data',
  metrics: 'data',
  table: 'data',
  testimonial: 'quote',
  pullquote: 'quote',
  conclusion: 'closing',
  summary: 'closing',
  'thank-you': 'closing',
  end: 'closing',
};

const slideLayout = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if ((SLIDE_LAYOUTS as readonly string[]).includes(normalised)) return normalised;

  return LAYOUT_ALIASES[normalised] ?? 'custom';
}, z.enum(SLIDE_LAYOUTS));

/**
 * A slide's generated backdrop.
 *
 * `prompt` is the Background Designer's decision; `imagePath` is filled in
 * after the `generate_image` tool has actually produced the file. A slide with
 * neither simply uses the StyleSpec's background colour, which is the right
 * answer for most slides — a busy backdrop behind body copy is a bug.
 */
export const slideBackgroundSchema = z.object({
  prompt: z.string().min(1),
  /** Set by the pipeline once the tool has run. Never by the agent. */
  imagePath: z.string().optional(),
  /** 0-1. How far the image is faded toward the background colour for legibility. */
  dim: measurement(z.number().min(0).max(1)).default(0.35),
});

export type SlideBackground = z.infer<typeof slideBackgroundSchema>;

export const slideSpecSchema = z.object({
  slideNumber: z.number().int().positive(),
  layout: slideLayout,
  /**
   * The slide's shape, from a fixed set. Code derives every slot rectangle
   * from it and the StyleSpec, so the designer chooses the composition and
   * never the coordinates.
   *
   * Optional: a slide without one falls back to the boxes the designer wrote,
   * which is the older path and still supported.
   */
  archetype: z.enum(LAYOUT_ARCHETYPES).optional().catch(undefined),
  /** Generated backdrop, if the Background Designer asked for one. */
  background: slideBackgroundSchema.optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  elements: z.array(slideElementSchema),
  speakerNotes: z.string().optional(),
});

export type SlideSpec = z.infer<typeof slideSpecSchema>;

// ── BackgroundPlan ───────────────────────────────────────────────────────────

/**
 * The Background Designer's output: which slides get a generated backdrop.
 *
 * Deliberately per-slide and deliberately sparse — the agent is told to leave
 * most slides alone. Its whole job is deciding WHERE a backdrop helps and what
 * it should depict; the `generate_image` tool does the making.
 */
export const backgroundPlanSchema = z.object({
  backgrounds: z.array(
    z.object({
      slideNumber: z.number().int().positive(),
      prompt: z.string().min(1),
      dim: measurement(z.number().min(0).max(1)).default(0.35),
      rationale: z.string().optional(),
    }),
  ),
});

export type BackgroundPlan = z.infer<typeof backgroundPlanSchema>;

// ── ResearchBrief ────────────────────────────────────────────────────────────

/**
 * What the deck is allowed to claim.
 *
 * The first stage of a build, and the only one permitted to introduce facts.
 * Everything after it works from this object: the planner sequences these
 * findings, the designer writes them onto slides, and the reviewer has
 * something to check a claim against. A pipeline without it produces a deck
 * that is fluent about a topic it never looked at.
 *
 * `sources` records where each finding came from — a supplied document, a web
 * result, or the model's own knowledge. The third is legitimate and is marked
 * as such rather than dressed up as a citation.
 */
export const researchSourceSchema = z.object({
  kind: z.enum(['document', 'web', 'model-knowledge']),
  title: z.string().min(1),
  /** Present for web sources; absent for documents and recalled knowledge. */
  url: z.string().optional(),
});

export const researchBriefSchema = z.object({
  topic: z.string().min(1),
  /** Two or three sentences: what this topic is and why the deck exists. */
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1),
        detail: z.string().optional(),
        /** Title or URL of the source this came from. */
        source: z.string().optional(),
        /**
         * How well supported the claim is. `low` is a signal to the planner
         * to soften or drop it, not a licence to state it plainly anyway.
         */
        confidence: z.enum(['high', 'medium', 'low']).default('medium'),
      }),
    )
    .min(1),
  /** Vocabulary the audience will need defined. */
  keyTerms: z.array(z.string()).default([]),
  /** What could not be established. Named, never quietly filled in. */
  openQuestions: z.array(z.string()).default([]),
  sources: z.array(researchSourceSchema).default([]),
});

export type ResearchBrief = z.infer<typeof researchBriefSchema>;

// ── QAReport ─────────────────────────────────────────────────────────────────

export const qaReportSchema = z.object({
  passed: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      slideNumber: z.number().int().positive().optional(),
      category: z.enum([
        'overflow',
        'overlap',
        'readability',
        'style',
        'content',
        'technical',
      ]),
      description: z.string(),
      recommendation: z.string().optional(),
    }),
  ),
});

export type QAReport = z.infer<typeof qaReportSchema>;

// ── Critique ─────────────────────────────────────────────────────────────────

/**
 * A second opinion on a draft specialist's output, from a different model.
 *
 * Deliberately lighter than QAReport: there is no code-computed fact to check
 * this against, so there is no `critical` severity and nothing to merge —
 * `approved: false` triggers exactly one revision call, see
 * `Manager.critiqueAndRevise`.
 */
export const critiqueSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(['minor', 'major']),
      description: z.string(),
      recommendation: z.string().optional(),
    }),
  ),
});

export type Critique = z.infer<typeof critiqueSchema>;

// ── Agent state ──────────────────────────────────────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'researching'
  | 'planning'
  /** Outline drafted; the build is paused until a person approves it. */
  | 'awaiting-review'
  | 'analyzing-style'
  | 'designing'
  | 'illustrating'
  | 'generating'
  | 'reviewing'
  | 'revising'
  | 'complete'
  | 'error';

export interface AgentState {
  userRequest: string;
  presentation?: {
    title?: string;
    audience?: string;
    objective?: string;
    slideCount?: number;
  };
  sourceFiles: string[];
  styleReference?: { imagePath: string };
  styleSpec?: StyleSpec;
  researchBrief?: ResearchBrief;
  contentPlan?: ContentPlan;
  slideSpecs?: SlideSpec[];
  pptxPath?: string;
  renderedSlides?: string[];
  qaReport?: QAReport;
  revisionCount: number;
  status: AgentStatus;
}

// ── Skill / Tool contracts ───────────────────────────────────────────────────

export interface Skill<TInput, TOutput> {
  name: string;
  description: string;
  run(input: TInput, context: AgentState): Promise<TOutput>;
}

export interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  execute(input: TInput): Promise<TOutput>;
}

/** Thrown by any pipeline stage so the Manager can attribute a failure. */
export class AgentError extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(message: string, code: string, stage: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.stage = stage;
  }
}
