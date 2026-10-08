import 'server-only';

import { z } from 'zod';

import {
  captionUsesSelectedLanguage,
  narrationUsesSelectedLanguage,
  usesEnglishProductionScript,
  videoLanguage,
  type VideoLanguageCode,
} from '@/lib/videos/languages';
import prompts from '@/lib/videos/lesson-prompts.json';
import { generateLocalStructured, translateLocalTexts } from '@/lib/videos/local-ai';
import { auditOverlay, auditTimelines, coerceOverlay, LessonOverlaySchema } from '@/lib/videos/overlays';
import { fetchTopicReference, referenceBlock } from '@/lib/videos/reference';
import { integerToWords, spokenNarration } from '@/lib/videos/spoken';

// Words that make the no-CFG image model paint documents, slides or lettering.
// Only objects that carry lettering: a plain "board" (circuit board) or
// "sign" (signs of illness) is fine, a blackboard or a map is not.
export const PRINTED_MATTER = /\b(text|labels?|captions?|letters|lettering|numerals?|digits?|equations?|formulas?|signboards?|charts?|graphs?|diagrams?|infographics?|posters?|(?:black|white|chalk|bulletin|notice)boards?|screens?|monitors?|pages?|books?|notebooks?|newspapers?|documents?|storyboards?|maps?|scrolls?|manuscripts?|parchments?|written|writing|inscriptions?|inscribed|labell?ed|engraved|embossed|stamped)\b/i;
// A short quoted word ('IoT', "C") is lettering the image model would paint.
const QUOTED_WORD = /(^|\s)["“‘'][A-Za-z0-9+#]{1,12}["”’']/;
const mentionsLettering = (text: string) => PRINTED_MATTER.test(text) || QUOTED_WORD.test(text);

/** Drop math tokens and keep at most five words; the exact math lives in the overlay. */
export function cleanCaption(value: unknown): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((word) => word && !/[0-9=+*/^<>]/.test(word))
    .map((word) => word.replace(/^[,.;:!?"'()]+|[,.;:!?"'()]+$/g, ''))
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
    .slice(0, 40)
    .trim();
}

const CaptionSchema = z.preprocess(
  cleanCaption,
  z.string().min(3, 'Caption must be a 1-5 word headline without digits').max(40),
);
const VisualDescriptionSchema = z.string().trim().min(20).max(500).refine(
  (value) => !mentionsLettering(value),
  'visualDescription must describe only physical objects; never printed matter, writing, diagrams, boards, screens or paper',
);
const MotionDescriptionSchema = z.string().trim().min(15).max(800).refine(
  (value) => /\bStart\s*:/i.test(value)
    && /\bThen\s*:/i.test(value)
    && /\bEnd\s*:/i.test(value),
  'Motion must contain ordered Start, Then, and End action beats',
);

const LessonSceneSchema = z.object({
  index: z.number().int().min(1).max(12),
  fact: z.string().trim().min(10).max(400),
  narration: z.string().trim().min(5).max(500),
  caption: CaptionSchema,
  visualDescription: VisualDescriptionSchema,
  motionDescription: MotionDescriptionSchema,
  overlay: LessonOverlaySchema,
});

function sequentialIndexes(
  scenes: { index: number }[],
  ctx: z.RefinementCtx,
  expectedCount?: number,
): void {
  if (expectedCount !== undefined && scenes.length !== expectedCount) {
    ctx.addIssue({ code: 'custom', path: ['scenes'], message: `Expected exactly ${expectedCount} scenes` });
  }
  scenes.forEach((scene, position) => {
    if (scene.index !== position + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', position, 'index'],
        message: `Expected scene index ${position + 1}`,
      });
    }
  });
}

export const LessonPlanSchema = z.object({
  title: z.string().trim().min(3).max(200),
  learningObjective: z.string().trim().min(10).max(500),
  visualBible: z.string().trim().min(40).max(600),
  scenes: z.array(LessonSceneSchema).min(8).max(12),
}).superRefine((plan, ctx) => sequentialIndexes(plan.scenes, ctx));

export type LessonPlan = z.infer<typeof LessonPlanSchema>;

const NarrationRevisionSchema = z.object({
  scenes: z.array(z.object({
    index: z.number().int().min(1).max(12),
    narration: z.string().trim().min(5).max(500),
  })).min(8).max(12),
});


type LooseScene = Record<string, unknown>;

function mapScenes(output: unknown, update: (scene: LooseScene) => LooseScene): unknown {
  if (!output || typeof output !== 'object' || !Array.isArray((output as { scenes?: unknown }).scenes)) {
    return output;
  }
  const draft = output as { scenes: unknown[] };
  return {
    ...draft,
    scenes: draft.scenes.map((scene) => (
      scene && typeof scene === 'object' ? update(scene as LooseScene) : scene
    )),
  };
}

/** Rewrite digits and math symbols in narration as spoken English. */
function normalizeNarration(output: unknown): unknown {
  return mapScenes(output, (scene) => (
    typeof scene.narration === 'string'
      ? { ...scene, narration: spokenNarration(scene.narration) }
      : scene
  ));
}

/** Writer output: spoken narration, and repair or drop malformed overlays. */
function normalizeWriter(output: unknown): unknown {
  return mapScenes(normalizeNarration(output), (scene) => (
    'overlay' in scene ? { ...scene, overlay: coerceOverlay(scene.overlay) } : scene
  ));
}

/**
 * Drop sentences that mention lettered objects when enough description remains,
 * and add the Start/Then/End beats when the model wrote plain sentences. A
 * visual that is still unusable after this goes back to the model.
 */
/**
 * Rewrite lettering-prone phrases instead of rejecting the whole picture:
 * "printed circuit board" is just a circuit board, "a box labeled 'IoT'" is a
 * box, and a screen becomes a dark glass panel so nothing invites fake text.
 */
export function scrubLettering(visual: string): string {
  return visual
    .replace(/\bprinted\s+circuit\s+boards?\b/gi, 'circuit board')
    .replace(/\bPCBs?\b/g, 'circuit board')
    .replace(/,?\s*(?:labell?ed|marked|engraved|embossed|stamped|printed|inscribed)\s+(?:with\s+)?(?:the\s+(?:word|letters?|name|number)s?\s+)?(?:["“‘'][^"”’']{1,40}["”’']|\w+)/gi, '')
    .replace(/(^|\s)["“‘'][A-Za-z0-9+#]{1,12}["”’']/g, '$1')
    .replace(/\b(?:(?:lcd|led|oled|digital|touch|small|tiny|large|glowing|black|dark)\s+)*(?:screens?|monitors?|displays?)\b/gi, 'dark glass panel')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim();
}

function normalizeDirection(output: unknown): unknown {
  return mapScenes(output, (scene) => {
    const next = { ...scene };
    if (typeof next.visualDescription === 'string') {
      next.visualDescription = scrubLettering(next.visualDescription);
    }
    if (typeof next.visualDescription === 'string' && mentionsLettering(next.visualDescription)) {
      const sentences = next.visualDescription.split(/(?<=[.!?])\s+/);
      const kept = sentences.filter((sentence) => !mentionsLettering(sentence));
      // Keep a trimmed visual only when it still stands on its own; otherwise
      // the model rewrites it on the next attempt.
      if (kept.length >= 2 && !/^\s*(?:it|they|this|these)\b/i.test(kept[0])) {
        next.visualDescription = kept.join(' ').trim();
      }
    }
    if (typeof next.motionDescription === 'string' && !/\bStart\s*:/i.test(next.motionDescription)) {
      const sentences = next.motionDescription.split(/(?<=[.!?])\s+/).filter(Boolean);
      if (sentences.length >= 3) {
        const middle = sentences.slice(1, -1).join(' ');
        next.motionDescription = `Start: ${sentences[0]} Then: ${middle} End: ${sentences[sentences.length - 1]}`;
      } else if (sentences.length === 2) {
        next.motionDescription = `Start: ${sentences[0]} Then: ${sentences[1]} End: the objects settle in their final positions.`;
      }
    }
    return next;
  });
}

function fillPrompt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key] ?? ''));
}

/**
 * Two focused stages work far better with the small local planner than one
 * prompt that mixes curriculum writing and art direction: the writer produces
 * audited facts, narration, captions and exact math; the director turns each
 * fact into one truthful, animatable photograph.
 */
export async function planLesson(input: {
  classLevel: number;
  subject: string;
  topic: string;
  languageCode: VideoLanguageCode;
  targetDurationSeconds: 60 | 90;
}): Promise<LessonPlan> {
  const language = videoLanguage(input.languageCode);
  const sceneCount = input.targetDurationSeconds === 60 ? 8 : 12;
  const values = {
    duration: input.targetDurationSeconds,
    classLevel: input.classLevel,
    subject: input.subject,
    topic: input.topic,
    sceneCount,
    languageLabel: language.label,
  };

  const WriterSchema = z.object({
    title: z.string().trim().min(3).max(200),
    learningObjective: z.string().trim().min(10).max(500),
    scenes: z.array(z.object({
      index: z.number().int().min(1).max(12),
      fact: z.string().trim().min(10).max(400),
      narration: z.string().trim().min(5).max(500),
      caption: CaptionSchema,
      overlay: LessonOverlaySchema,
    })).min(8).max(12),
  }).superRefine((draft, ctx) => {
    sequentialIndexes(draft.scenes, ctx, sceneCount);
    const narration = draft.scenes.map((scene) => scene.narration).join(' ');
    if (!narrationUsesSelectedLanguage(narration, 'en-IN')) {
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'Source narration must remain in clear English' });
    }
    const facts = [draft.learningObjective, ...draft.scenes.map((scene) => scene.fact)].join(' ');
    if (!usesEnglishProductionScript(facts)) {
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'Facts must remain in English' });
    }
    draft.scenes.forEach((scene, position) => {
      if (/[0-9=+*/^<>]/.test(scene.narration)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', position, 'narration'],
          message: 'Narration is spoken aloud: write numbers and operations as words, no digits or symbols',
        });
      }
      // Spoken numbers ("sixteen seventy-four") lengthen sentences, so allow slack.
      const words = scene.narration.split(/\s+/).length;
      if (words < 6 || words > 24) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', position, 'narration'],
          message: `Narration has ${words} words; write one sentence of 10-14 words`,
        });
      }
    });
  });

  const referenceData = await fetchTopicReference(input.topic, input.subject);
  const reference = referenceBlock(referenceData);
  const written = await generateLocalStructured({
    stage: 'video-lesson-writer',
    timeoutMs: 300_000,
    maxValidationAttempts: 3,
    schema: WriterSchema,
    normalize: normalizeWriter,
    systemPrompt: fillPrompt(prompts.writerSystem, values),
    userPrompt: `${fillPrompt(prompts.writerUser, values)}${reference}`,
  });

  const audited = await auditFacts(written.scenes, values, reference, referenceData?.text ?? null);
  const scenes = dropUnmotivatedArrows(auditTimelines(await repairOverlays(audited, input.topic)));

  const directions = await directScenes(scenes, values, input);

  return LessonPlanSchema.parse({
    title: input.topic.slice(0, 200),
    learningObjective: written.learningObjective,
    visualBible: `Scene subjects: ${directions.map((direction) => direction.subject).join('; ')}`
      .slice(0, 600).padEnd(40, '.'),
    scenes: scenes.map((scene, position) => ({
      ...scene,
      visualDescription: directions[position].visualDescription,
      motionDescription: directions[position].motionDescription,
    })),
  });
}

// An arrow drawn across the photo only helps when the sentence describes
// movement or direction; otherwise it covers the subject and means nothing.
const DIRECTIONAL = /\b(move[sd]?|moving|flows?|flowing|travels?|travell?ing|toward|towards|into|onto|through|enters?|entering|rises?|rising|falls?|falling|increases?|increasing|decreases?|decreasing|grows?|growing|spreads?|carries|carried|pushe[sd]|pulls?|up|down|from\s+\w+\s+to)\b/i;

function dropUnmotivatedArrows<T extends { narration: string; fact: string; overlay: z.infer<typeof LessonOverlaySchema> }>(scenes: T[]): T[] {
  return scenes.map((scene) => (
    scene.overlay.kind === 'arrow' && !DIRECTIONAL.test(`${scene.narration} ${scene.fact}`)
      ? { ...scene, overlay: { kind: 'none' } as z.infer<typeof LessonOverlaySchema> }
      : scene
  ));
}

const PROGRAMMING_GUIDANCE = '\n\nFor programming lessons, NEVER depict a computer, monitor, terminal, code, or anything printed. Use one recurring tangible analogy: a small wooden conveyor track with colored wooden tokens, one brass action lever, and a movable stop gate. Tokens passing the lever illustrate repeated execution; the stop gate illustrates termination. Give every scene a visibly different starting state: vary which tokens are at the entrance, under the lever, beyond the lever or against the gate; whether the lever is raised or lowered; and whether the gate is open or closed. The arrangement and physical action must mirror that scene\'s audited fact, not merely decorate it. Do not repeat any visualDescription, even if the motion differs. Exact Python syntax belongs in narration or verified software-drawn overlays, never in the generated photograph. Every visualDescription must name only those tangible props and their positions.';

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'along', 'also', 'among', 'another', 'around', 'because', 'been',
  'before', 'being', 'below', 'between', 'both', 'called', 'clear', 'clearly', 'could', 'each', 'every',
  'first', 'from', 'have', 'into', 'just', 'large', 'like', 'made', 'make', 'many', 'more', 'most', 'much',
  'next', 'only', 'other', 'over', 'placed', 'same', 'scene', 'shows', 'side', 'small', 'some', 'such',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'used',
  'uses', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'within', 'would', 'your', 'plain',
  'wooden', 'table', 'surface', 'resting', 'rests', 'sitting', 'sits', 'stands', 'standing', 'arranged',
]);

/** Five-letter stems of content words, so "applications" matches "applied". */
function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => word.slice(0, 5)));
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  for (const word of left) if (right.has(word)) return true;
  return false;
}

type SceneDirection = { subject: string; visualDescription: string; motionDescription: string };

const DEFAULT_MOTION = 'Start: the objects rest in place. Then: the main object turns slowly toward the viewer. End: the objects settle in their final positions.';

/**
 * Last resort for one scene: build the picture from that scene's own subject,
 * never from another scene, so the picture still follows its narration.
 */
function fallbackDirection(last: unknown, scene: WrittenScene, topic: string): SceneDirection {
  const draft = (last && typeof last === 'object' ? last : {}) as Partial<Record<keyof SceneDirection, unknown>>;
  const rawSubject = typeof draft.subject === 'string' ? draft.subject.trim() : '';
  const subject = rawSubject && !mentionsLettering(rawSubject) ? rawSubject.slice(0, 120) : topic.slice(0, 120);
  const visual = typeof draft.visualDescription === 'string'
    ? draft.visualDescription.split(/(?<=[.!?])\s+/).filter((sentence) => !mentionsLettering(sentence)).join(' ').trim()
    : '';
  const visualDescription = visual.length >= 40 && overlaps(contentWords(subject), contentWords(visual))
    ? visual.slice(0, 500)
    : `${subject.charAt(0).toUpperCase()}${subject.slice(1)}, shown clearly and large, arranged neatly together.`;
  const motion = typeof draft.motionDescription === 'string'
    && /\bStart\s*:/i.test(draft.motionDescription) && /\bThen\s*:/i.test(draft.motionDescription)
    && /\bEnd\s*:/i.test(draft.motionDescription)
    ? draft.motionDescription
    : DEFAULT_MOTION;
  if (scene.index && !rawSubject) {
    console.warn(`[lesson-planner] scene ${scene.index} picture built from the lesson topic`);
  }
  return { subject, visualDescription, motionDescription: motion };
}

/**
 * Design each scene's picture from that scene's own narration. A code check
 * requires the named subject to come from the narration and to appear in the
 * picture, and forbids repeating an earlier scene's picture, so the video
 * follows what is being said instead of showing one object throughout.
 */
async function directScenes(
  scenes: WrittenScene[],
  values: Record<string, string | number>,
  input: { subject: string; topic: string },
): Promise<SceneDirection[]> {
  const programming = /python|programming|coding|algorithm|\b(?:for|while)\s+loops?\b/i
    .test(`${input.subject} ${input.topic}`);
  const systemPrompt = `${prompts.directorSceneSystem}${programming ? PROGRAMMING_GUIDANCE : ''}`;
  const outline = scenes.map((scene) => `${scene.index}. ${scene.narration}`).join('\n');
  const results: SceneDirection[] = [];

  for (const scene of scenes) {
    const context = contentWords(`${scene.fact} ${scene.narration} ${scene.caption}`);
    const SceneSchema = z.object({
      subject: z.string().trim().min(3).max(120),
      visualDescription: VisualDescriptionSchema,
      motionDescription: MotionDescriptionSchema,
    }).superRefine((draft, ctx) => {
      const subjectWords = contentWords(draft.subject);
      if (!overlaps(subjectWords, context)) {
        ctx.addIssue({ code: 'custom', path: ['subject'], message: 'The subject must be something this scene\'s narration talks about' });
      }
      if (!overlaps(subjectWords, contentWords(draft.visualDescription))) {
        ctx.addIssue({ code: 'custom', path: ['visualDescription'], message: 'The photograph must show the subject' });
      }
      if (results.some((earlier) => earlier.visualDescription.toLowerCase() === draft.visualDescription.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path: ['visualDescription'], message: 'This repeats an earlier scene\'s picture' });
      }
      if (!usesEnglishProductionScript(`${draft.subject} ${draft.visualDescription} ${draft.motionDescription}`)) {
        ctx.addIssue({ code: 'custom', path: ['visualDescription'], message: 'Production directions must remain in English' });
      }
    });
    const previous = results.map((earlier, position) => `- scene ${position + 1}: ${earlier.subject}`).join('\n') || '- none yet';
    let direction: SceneDirection;
    try {
      direction = await generateLocalStructured({
        stage: 'video-lesson-director',
        timeoutMs: 180_000,
        maxValidationAttempts: 2,
        schema: SceneSchema,
        normalize: (output) => {
          const wrapped = normalizeDirection({ scenes: [output] }) as { scenes?: unknown[] };
          return wrapped.scenes?.[0] ?? output;
        },
        systemPrompt,
        userPrompt: fillPrompt(prompts.directorSceneUser, {
          ...values,
          outline,
          index: scene.index,
          fact: scene.fact,
          narration: scene.narration,
          previous,
        }),
      });
    } catch (error) {
      console.warn(`[lesson-planner] scene ${scene.index} director retry with relaxed checks`, error instanceof Error ? error.message.slice(0, 300) : error);
      // One simpler attempt that keeps the safety and lettering rules but not
      // the subject-matching checks, before the last-resort picture.
      try {
        direction = await generateLocalStructured({
          stage: 'video-lesson-director',
          timeoutMs: 180_000,
          maxValidationAttempts: 2,
          schema: z.object({
            subject: z.string().trim().min(3).max(120),
            visualDescription: VisualDescriptionSchema,
            motionDescription: MotionDescriptionSchema,
          }),
          normalize: (output) => {
            const wrapped = normalizeDirection({ scenes: [output] }) as { scenes?: unknown[] };
            return wrapped.scenes?.[0] ?? output;
          },
          systemPrompt,
          userPrompt: fillPrompt(prompts.directorSceneUser, {
            ...values,
            outline,
            index: scene.index,
            fact: scene.fact,
            narration: scene.narration,
            previous,
          }),
        });
      } catch (relaxedError) {
        console.warn(`[lesson-planner] scene ${scene.index} director fallback`, relaxedError instanceof Error ? relaxedError.message.slice(0, 300) : relaxedError);
        direction = fallbackDirection(undefined, scene, input.topic);
      }
    }
    results.push(direction);
  }
  return results;
}

/**
 * A separate fact-checking pass. The small local model makes confident
 * mistakes (for example a coronation year from a different event), and a
 * second, narrowly focused reading catches many of them. Overlays are audited
 * against the corrected facts afterwards, so a corrected number also removes a
 * graphic that showed the old one. This lowers, but cannot eliminate, errors.
 */
/**
 * Numbers of 11 and above in a fact (years, ages, counts) that the reference
 * text never mentions, as digits or as words. These are the details the local
 * model most often invents.
 */
export function unsupportedNumbers(fact: string, referenceText: string): string[] {
  const haystack = referenceText.toLowerCase().replace(/,/g, '');
  const found = fact.replace(/(\d),(\d)/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(found)].filter((raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 10) return false;
    if (new RegExp(`(^|[^0-9.])${raw.replace('.', '\\.')}([^0-9]|$)`).test(haystack)) return false;
    return !(Number.isInteger(value) && haystack.includes(integerToWords(value)));
  });
}

/** Remove "in 1656", "at the age of 16", "16 years" style details as a last resort. */
function stripNumbers(fact: string, numbers: string[]): string {
  let result = fact;
  for (const raw of numbers) {
    const number = raw.replace('.', '\\.');
    result = result
      .replace(new RegExp(`,?\\s*(?:in|at|on|by|around|about|over|nearly|approximately|from|until|since)\\s+(?:the\\s+age\\s+of\\s+|age\\s+)?${number}(?:\\s+(?:years?|AD|CE|BC|BCE))?(?=[\\s,.;]|$)`, 'gi'), '')
      .replace(new RegExp(`\\b${number}\\b\\s*`, 'g'), 'several ');
  }
  return result.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
}

/**
 * A separate fact-checking pass. The small local model makes confident
 * mistakes (for example a coronation year from a different event), and a
 * second, narrowly focused reading catches many of them, especially when an
 * automatic check names the numbers the reference does not support. Overlays
 * are audited against the corrected facts afterwards. This lowers, but cannot
 * eliminate, errors.
 */
async function auditFacts(
  scenes: WrittenScene[],
  values: Record<string, string | number>,
  reference: string,
  referenceText: string | null,
): Promise<WrittenScene[]> {
  const AuditSchema = z.object({
    scenes: z.array(z.object({
      index: z.number().int().min(1).max(12),
      verdict: z.enum(['correct', 'corrected', 'softened']),
      fact: z.string().trim().min(10).max(400),
      narration: z.string().trim().min(5).max(500),
    })),
  }).superRefine((draft, ctx) => {
    sequentialIndexes(draft.scenes, ctx, scenes.length);
    draft.scenes.forEach((scene, position) => {
      const words = scene.narration.split(/\s+/).length;
      if (words < 6 || words > 24) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', position, 'narration'],
          message: `Narration has ${words} words; write one sentence of 10-14 words`,
        });
      }
    });
    const text = draft.scenes.flatMap((scene) => [scene.fact, scene.narration]).join(' ');
    if (!usesEnglishProductionScript(text) || !narrationUsesSelectedLanguage(text, 'en-IN')) {
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'Facts and narration must remain in English' });
    }
  });
  const flagsFor = (current: WrittenScene[]) => (referenceText
    ? current
      .map((scene) => ({ index: scene.index, numbers: unsupportedNumbers(scene.fact, referenceText) }))
      .filter((flag) => flag.numbers.length > 0)
    : []);

  let current = scenes;
  for (let round = 1; round <= 2; round += 1) {
    const flags = flagsFor(current);
    if (round > 1 && flags.length === 0) break;
    const flagText = flags.length
      ? `\n\nAn automatic check found numbers that the reference text does not support. For each listed scene, correct the number from the reference text or remove that detail, and give it verdict "corrected" or "softened":\n${flags.map((flag) => `- Scene ${flag.index}: ${flag.numbers.join(', ')}`).join('\n')}`
      : '';
    try {
      const result = await generateLocalStructured({
        stage: 'video-lesson-fact-audit',
        timeoutMs: 300_000,
        maxValidationAttempts: 2,
        schema: AuditSchema,
        normalize: normalizeNarration,
        systemPrompt: prompts.auditSystem,
        userPrompt: fillPrompt(prompts.auditUser, {
          ...values,
          scenes: JSON.stringify(current.map((scene) => ({
            index: scene.index,
            fact: scene.fact,
            narration: scene.narration,
          }))),
        }) + flagText + reference,
      });
      const changed = result.scenes.filter((scene) => scene.verdict !== 'correct');
      if (changed.length) {
        console.info(`[lesson-planner] fact audit round ${round} changed scenes ${changed.map((scene) => `${scene.index}:${scene.verdict}`).join(', ')}`);
      }
      current = current.map((scene, position) => ({
        ...scene,
        fact: result.scenes[position].fact,
        narration: result.scenes[position].narration,
      }));
    } catch (error) {
      console.warn(`[lesson-planner] fact audit round ${round} unavailable; keeping current facts`, error);
      break;
    }
    if (!referenceText) break;
  }

  // Last resort: an unsupported number never reaches the voice-over. Remove
  // the detail and speak the cleaned fact itself for that scene.
  const remaining = flagsFor(current);
  if (remaining.length) {
    console.warn(`[lesson-planner] removing unsupported numbers ${remaining.map((flag) => `${flag.index}:${flag.numbers.join('/')}`).join(', ')}`);
  }
  return current.map((scene) => {
    const flag = remaining.find((item) => item.index === scene.index);
    if (!flag) return scene;
    const fact = stripNumbers(scene.fact, flag.numbers);
    // Remove the spoken form ("sixteen fifty-six") from the short narration
    // rather than re-speaking the whole fact, which can be too long for a scene.
    let narration = scene.narration;
    for (const raw of flag.numbers) {
      const spoken = spokenNarration(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      narration = narration
        .replace(new RegExp(`,?\\s*(?:in|at|on|by|around|about|over|nearly|approximately|from|until|since)\\s+(?:the\\s+age\\s+of\\s+)?${spoken}(?:\\s+years?)?`, 'gi'), '')
        .replace(new RegExp(spoken, 'gi'), 'several');
    }
    narration = narration.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
    return { ...scene, fact, narration };
  });
}

type WrittenScene = {
  index: number;
  fact: string;
  narration: string;
  caption: string;
  overlay: z.infer<typeof LessonOverlaySchema>;
};

/**
 * Give the writer one targeted chance to fix overlays that fail the math audit;
 * anything still wrong is dropped rather than drawn.
 */
async function repairOverlays(scenes: WrittenScene[], topic: string): Promise<WrittenScene[]> {
  const problems = scenes
    .map((scene) => ({ scene, issue: auditOverlay(scene.overlay, scene.fact).issue }))
    .filter((item): item is { scene: WrittenScene; issue: string } => item.issue !== null);
  if (problems.length === 0) return scenes;

  const RepairSchema = z.object({
    scenes: z.array(z.object({
      index: z.number().int().min(1).max(12),
      fact: z.string().trim().min(10).max(400),
      overlay: LessonOverlaySchema,
    })),
  });
  let repaired: z.infer<typeof RepairSchema>['scenes'] = [];
  try {
    repaired = (await generateLocalStructured({
      stage: 'video-lesson-math-repair',
      normalize: (output) => mapScenes(output, (scene) => ({ ...scene, overlay: coerceOverlay(scene.overlay) })),
      timeoutMs: 180_000,
      schema: RepairSchema,
      systemPrompt: prompts.repairSystem,
      userPrompt: fillPrompt(prompts.repairUser, {
        topic,
        lesson: JSON.stringify(scenes.map((scene) => ({ index: scene.index, fact: scene.fact }))),
        problems: JSON.stringify(problems.map(({ scene, issue }) => ({
          index: scene.index,
          fact: scene.fact,
          overlay: scene.overlay,
          problem: issue,
        }))),
      }),
    })).scenes;
  } catch (error) {
    console.warn('[lesson-planner] overlay repair failed; dropping failing overlays', error);
  }

  return scenes.map((scene) => {
    const fix = repaired.find((item) => item.index === scene.index);
    const candidate = fix && usesEnglishProductionScript(fix.fact)
      ? { ...scene, fact: fix.fact, overlay: fix.overlay }
      : scene;
    const audited = auditOverlay(candidate.overlay, candidate.fact);
    if (audited.issue) {
      console.warn(`[lesson-planner] scene ${scene.index} overlay dropped: ${audited.issue}`);
    }
    return { ...candidate, overlay: audited.overlay };
  });
}

export async function adjustNarrationToFit(
  plan: LessonPlan,
  input: {
    languageCode: VideoLanguageCode;
    targetDurationSeconds: 60 | 90;
    measuredDurationSeconds: number;
  },
): Promise<LessonPlan> {
  const language = videoLanguage(input.languageCode);
  const currentText = narrationFromPlan(plan);
  const desiredDuration = input.targetDurationSeconds - 4;
  const ratio = desiredDuration / Math.max(1, input.measuredDurationSeconds);
  const targetCharacters = Math.max(
    plan.scenes.length * 12,
    Math.floor(currentText.length * ratio * (ratio < 1 ? 0.9 : 0.98)),
  );
  const direction = ratio < 1 ? 'shorten' : 'expand';
  const revisionSchema = NarrationRevisionSchema.superRefine((revision, ctx) => {
    if (revision.scenes.length !== plan.scenes.length) {
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'Scene count changed' });
    }
    revision.scenes.forEach((scene, position) => {
      if (scene.index !== position + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', position, 'index'],
          message: `Expected scene index ${position + 1}`,
        });
      }
    });
    const narration = revision.scenes.map((scene) => scene.narration).join(' ');
    if (direction === 'shorten' && narration.length > targetCharacters) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Combined narration must be at most ${targetCharacters} characters`,
      });
    }
    if (!narrationUsesSelectedLanguage(narration, 'en-IN')) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: 'Source narration must remain in clear English',
      });
    }
  });

  const revision = await generateLocalStructured({
    stage: 'video-narration-duration-editor',
    normalize: normalizeNarration,
    timeoutMs: 180_000,
    schema: revisionSchema,
    systemPrompt: `You are a precise educational narration editor.

${direction === 'shorten' ? 'Shorten' : 'Expand'} the narration so synthesized speech fits a ${input.targetDurationSeconds}-second lesson. Keep exactly one narration entry per scene and preserve the meaning of its supplied audited fact.

Rules:
- Write only in clear English. A dedicated local model translates the approved narration into ${language.promptName} afterward.
- Keep the narration conversational, factual, and age-appropriate. Never add a fact, number, name, example, claim, or conclusion that is absent from the audited facts.
- The narration is spoken aloud: write every number, variable and operation as words, never digits or symbols.
- Each scene should be one concise sentence that can be spoken clearly in its 7.5-second slot.
- Avoid introductions, greetings, repetition, filler, calls to action, and grand claims.
- The combined narration must be ${direction === 'shorten' ? `no more than ${targetCharacters}` : `about ${targetCharacters}`} characters.
- Return only scene indexes and revised narration in the required schema.`,
    userPrompt: `Measured speech duration: ${input.measuredDurationSeconds.toFixed(1)} seconds
Target video duration: ${input.targetDurationSeconds} seconds

Audited scenes:
${JSON.stringify(plan.scenes.map((scene) => ({
    index: scene.index,
    fact: scene.fact,
    narration: scene.narration,
  })))}`,
  });

  return {
    ...plan,
    scenes: plan.scenes.map((scene, index) => ({
      ...scene,
      narration: revision.scenes[index].narration,
    })),
  };
}

/**
 * Captions are 1-5 words, far too short for the narration script check (which
 * needs 12+ native letters). Keep a caption when most of its letters are in the
 * selected script (a variable such as "x" is fine); otherwise drop it so the
 * scene simply has no caption. A caption must never fail a whole lesson.
 */
// Translation sometimes turns a spoken "equals" back into "=", which the
// voice model reads poorly. Speak it as a word in the selected language.
const SPOKEN_EQUALS: Record<string, string> = {
  'hi-IN': 'बराबर',
  'mr-IN': 'बरोबर',
  'bn-IN': 'সমান',
  'gu-IN': 'બરાબર',
  'kn-IN': 'ಸಮ',
  'ml-IN': 'തുല്യം',
  'ta-IN': 'சமம்',
  'te-IN': 'సమానం',
};

function speakableNarration(text: string, languageCode: VideoLanguageCode): string {
  const equals = SPOKEN_EQUALS[languageCode] ?? 'equals';
  return text.replace(/\s*=\s*/g, ` ${equals} `).replace(/\s{2,}/g, ' ').trim();
}

function translatedCaption(raw: string, languageCode: VideoLanguageCode): string {
  const caption = raw.replace(/[।.]+$/u, '').trim().slice(0, 60);
  if (captionUsesSelectedLanguage(caption, languageCode)) return caption;
  console.warn(`[lesson-planner] caption dropped, not in ${languageCode}: ${caption}`);
  return '';
}

export async function translateLessonPlan(
  plan: LessonPlan,
  languageCode: VideoLanguageCode,
): Promise<LessonPlan> {
  if (languageCode === 'en-IN') return plan;
  const language = videoLanguage(languageCode);
  const sceneCount = plan.scenes.length;
  const translations = await translateLocalTexts({
    languageCode,
    texts: [
      plan.title,
      ...plan.scenes.map((scene) => scene.narration),
      ...plan.scenes.map((scene) => scene.caption),
    ],
  });
  const translated: LessonPlan = {
    ...plan,
    title: translations[0],
    scenes: plan.scenes.map((scene, index) => ({
      ...scene,
      narration: speakableNarration(translations[index + 1], languageCode),
      caption: translatedCaption(translations[sceneCount + index + 1], languageCode),
    })),
  };
  // Re-translate only the scenes that did not come back in the selected script
  // (technical terms can dominate a short sentence), then judge the whole.
  const untranslated = translated.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => !narrationUsesSelectedLanguage(scene.narration, languageCode)
      && !captionUsesSelectedLanguage(scene.narration, languageCode));
  if (untranslated.length) {
    const retried = await translateLocalTexts({
      languageCode,
      texts: untranslated.map(({ index }) => plan.scenes[index].narration),
    });
    untranslated.forEach(({ index }, position) => {
      translated.scenes[index] = {
        ...translated.scenes[index],
        narration: speakableNarration(retried[position], languageCode),
      };
    });
  }
  const spokenText = translated.scenes.map((scene) => scene.narration).join(' ');
  if (!narrationUsesSelectedLanguage(spokenText, languageCode)) {
    throw new Error(`Local translation did not return ${language.promptName} in its expected script.`);
  }
  // The caption rules (word count, no digits) apply to the audited English
  // source; validate everything else, then keep the translated captions.
  const validated = LessonPlanSchema.parse({
    ...translated,
    scenes: translated.scenes.map((scene, index) => ({ ...scene, caption: plan.scenes[index].caption })),
  });
  return { ...validated, scenes: validated.scenes.map((scene, index) => ({ ...scene, caption: translated.scenes[index].caption })) };
}

/**
 * Scenes as sent to create_lesson_video_project. The visual bible is not
 * prefixed onto image prompts: the no-CFG image model paints any production
 * vocabulary it reads. Each visualDescription already repeats recurring traits.
 */
export function scenesForProject(plan: LessonPlan): LessonPlan['scenes'] {
  return plan.scenes;
}

export function narrationFromPlan(plan: LessonPlan): string {
  return plan.scenes.map((scene) => scene.narration.trim()).join(' ');
}
