import { z } from 'zod';

/**
 * Element motion: the zoom vocabulary, and the arithmetic behind it.
 *
 * One module, imported by three places that must not disagree — the pipeline
 * (which writes a default motion onto every element), `SlideCanvas` (which
 * draws it in the browser) and the editor panel (which lets a person change
 * it). A scale the renderer computes differently from the editor's slider is a
 * control that lies about what it does.
 *
 * ## Why an intensity rather than a scale
 *
 * The model is asked for how *much* a thing should move, never for the numbers
 * — the same split as `layouts.ts`, where the designer picks an archetype and
 * code computes the rectangles. `intensity` is 0-1; `motionFrames` turns it
 * into the two scales an animation runs between, and the direction of that
 * travel depends on the trigger:
 *
 * - `enter`: the element ANIMATES INTO its resting size. `zoom-in` starts
 *   small and grows to 1; `zoom-out` starts large and settles to 1. Either way
 *   it ends at exactly its laid-out size, which is what keeps motion from
 *   changing the composition the layout pass computed.
 * - `hover` / `click`: the element RESTS at 1 and departs from it while the
 *   pointer is on it (or the viewer has clicked it). `zoom-in` grows past 1,
 *   `zoom-out` shrinks below it.
 *
 * That is one rule with two readings, not two features: "zoom in" always means
 * the element gets closer to the viewer at the end of the gesture.
 *
 * ## What motion is NOT
 *
 * It never reaches the .pptx. `pptxgenjs` has no animation API, and a preview
 * that moves in ways the downloaded file cannot is a preview that has stopped
 * describing the deliverable — so `SlideCanvas` draws motion only in
 * `viewportMode: 'live'`, and the export/rasterise paths never see it. It also
 * never changes a `box`: every geometry pass in the Manager runs on the same
 * rectangles whether an element moves or not.
 */

/** A zoom's largest travel, as a fraction of the element's size, at intensity 1. */
export const MAX_ZOOM_DELTA = 0.5;

/** How far apart consecutive elements start, in seconds, when the pipeline staggers a slide. */
export const STAGGER_STEP = 0.12;

/** The most the stagger may push the last element out. Beyond this a slide feels slow. */
export const MAX_STAGGER = 0.72;

export const MOTION_EFFECTS = ['none', 'zoom-in', 'zoom-out'] as const;
export type MotionEffect = (typeof MOTION_EFFECTS)[number];

export const MOTION_TRIGGERS = ['enter', 'hover', 'click'] as const;
export type MotionTrigger = (typeof MOTION_TRIGGERS)[number];

export const MOTION_EASINGS = ['ease-out', 'ease-in', 'ease-in-out', 'linear', 'spring'] as const;
export type MotionEasing = (typeof MOTION_EASINGS)[number];

export const MOTION_ORIGINS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export type MotionOrigin = (typeof MOTION_ORIGINS)[number];

/** The CSS timing function each named easing stands for. `spring` overshoots slightly. */
export const EASING_CURVES: Record<MotionEasing, string> = {
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-in': 'cubic-bezier(0.7, 0, 0.84, 0)',
  'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
  linear: 'linear',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};

/** `transform-origin` for each named origin. */
export const ORIGIN_POSITIONS: Record<MotionOrigin, string> = {
  center: '50% 50%',
  top: '50% 0%',
  bottom: '50% 100%',
  left: '0% 50%',
  right: '100% 50%',
};

/** Seconds the model or a stored value may have written with a unit attached. */
const seconds = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    const ms = /^(-?[\d.]+)\s*ms$/i.exec(text);
    if (ms) return Number(ms[1]) / 1000;
    const parsed = Number(text.replace(/s$/i, ''));
    return Number.isNaN(parsed) ? value : parsed;
  }, schema);

/**
 * How one element moves.
 *
 * Every field has a default, so `{ effect: 'zoom-in' }` is a complete, valid
 * motion — which is what the Slide Designer is asked for and all a person has
 * to touch to get something reasonable. `.catch` on the enums for the same
 * reason it is used throughout `types.ts`: an unrecognised word is a spelling
 * difference, not a reason to lose a deck.
 */
export const motionSchema = z.object({
  effect: z.enum(MOTION_EFFECTS).default('none').catch('none'),
  /** 0-1. How far the zoom travels; `MAX_ZOOM_DELTA` at 1. */
  intensity: seconds(z.number().min(0).max(1)).default(0.35).catch(0.35),
  /** Seconds the movement takes. */
  duration: seconds(z.number().min(0.05).max(10)).default(0.6).catch(0.6),
  /** Seconds before it starts. Only meaningful for `enter`. */
  delay: seconds(z.number().min(0).max(10)).default(0).catch(0),
  easing: z.enum(MOTION_EASINGS).default('ease-out').catch('ease-out'),
  trigger: z.enum(MOTION_TRIGGERS).default('enter').catch('enter'),
  /** Fade in alongside the zoom. Ignored for `hover`/`click`, which have no entrance. */
  fade: z.boolean().default(true).catch(true),
  origin: z.enum(MOTION_ORIGINS).default('center').catch('center'),
});

export type Motion = z.infer<typeof motionSchema>;

/** The house default, before any per-element opinion is applied. */
export const DEFAULT_MOTION: Motion = motionSchema.parse({});

/**
 * The two scales an animation runs between, and the opacity it starts at.
 *
 * `from` is where the element sits before the gesture, `to` where it ends.
 * `fadeFrom` is 1 unless this is an entrance the author asked to fade.
 */
export function motionFrames(motion: Motion): { from: number; to: number; fadeFrom: number } {
  if (motion.effect === 'none') return { from: 1, to: 1, fadeFrom: 1 };

  const delta = motion.intensity * MAX_ZOOM_DELTA;
  const grows = motion.effect === 'zoom-in';

  if (motion.trigger === 'enter') {
    // Travels INTO the resting size, so the composition the layout pass
    // computed is what the slide settles at.
    return {
      from: grows ? 1 - delta : 1 + delta,
      to: 1,
      fadeFrom: motion.fade ? 0 : 1,
    };
  }

  // Rests at its real size and departs from it while the viewer is on it.
  return { from: 1, to: grows ? 1 + delta : 1 - delta, fadeFrom: 1 };
}

/** True when this motion actually does something. `none` is stored, not skipped. */
export function isAnimated(motion: Motion | undefined): motion is Motion {
  return motion !== undefined && motion.effect !== 'none';
}

/**
 * The house motion for an element the designer said nothing about.
 *
 * Deliberately sparse. A slide where every element moves is a slide nobody can
 * read while it settles, so this animates the things whose arrival is the
 * point — the heading, the picture, a headline number, a card — and leaves body
 * copy alone. Prose that zooms is prose you cannot start reading.
 *
 * Returns `null` for an element that should not move, which the Manager stores
 * as an explicit `none`: "decided not to" and "never considered" look the same
 * to a renderer but not to the person editing it afterwards.
 */
export function defaultMotionFor(type: string, role: string): Motion | null {
  if (role === 'title' || role === 'subtitle') {
    return motionSchema.parse({ effect: 'zoom-in', intensity: 0.2, duration: 0.55 });
  }
  if (type === 'image') {
    return motionSchema.parse({ effect: 'zoom-in', intensity: 0.4, duration: 0.8 });
  }
  if (type === 'statistic') {
    return motionSchema.parse({ effect: 'zoom-in', intensity: 0.5, duration: 0.5, easing: 'spring' });
  }
  if (type === 'card' || type === 'shape') {
    return motionSchema.parse({ effect: 'zoom-in', intensity: 0.15, duration: 0.5 });
  }
  return null;
}

/**
 * A short, human sentence describing a motion. Used by the editor so the panel
 * reads as a description rather than a form.
 */
export function describeMotion(motion: Motion | undefined): string {
  if (!isAnimated(motion)) return 'No animation';

  const frames = motionFrames(motion);
  const percent = Math.round(Math.abs(frames.to - frames.from) * 100);
  const verb = motion.effect === 'zoom-in' ? 'Zooms in' : 'Zooms out';

  const when =
    motion.trigger === 'enter'
      ? motion.delay > 0
        ? `${motion.delay.toFixed(2)}s after the slide opens`
        : 'as the slide opens'
      : motion.trigger === 'hover'
        ? 'while hovered'
        : 'when clicked';

  return `${verb} ${percent}% ${when}, over ${motion.duration.toFixed(2)}s`;
}
