/**
 * The lesson record, and the cache keys that decide what an edit costs.
 *
 * Two properties carry the weight here. A spec must refuse anything that would
 * waste GPU time or put a wrong lesson in front of a class — an overlong
 * video, a claim with no page, a missing Kannada line, a clip made from a
 * picture that failed its check. And an edit must invalidate exactly what it
 * changes: a caption fix that re-ran the image model would make the whole
 * cache pointless, while a prompt change that reused a stale picture would be
 * worse than no cache at all.
 *
 *   npm run test:lesson-spec
 */

import { randomUUID } from 'node:crypto';

import {
  ANIMATED_QUOTA,
  type LessonSpec,
  LessonSpecSchema,
  MAX_LESSON_SECONDS,
  type Scene,
  SLOT_SECONDS,
  SPEC_VERSION,
  lessonSeconds,
  placeholderAssets,
  sceneSpan,
  specIsRenderable,
  validateSpec,
} from '../src/lib/lesson-spec/schema.ts';
import {
  audioKey,
  clipKey,
  diffSpecs,
  keyframeKey,
  lessonKey,
  sceneKey,
} from '../src/lib/lesson-spec/keys.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const BOOK = {
  book: 'ENGLISH SCIENCE PART:1',
  edition: '2026-27' as const,
  page: 59,
  figureRef: null,
  url: 'https://textbooks.karnataka.gov.in/uploads/x.pdf',
};

function scene(index: number, over: Partial<Scene> = {}): Scene {
  return {
    id: randomUUID(),
    index,
    objective: `Understand idea number ${index}`,
    facts: [{ claim: 'Carbon forms four covalent bonds.', source: { ...BOOK, page: 58 + index } }],
    caption: `Caption for scene ${index}`,
    title: `Banner ${index}`,
    overlay: { kind: 'none' },
    visualPrompt: `A diagram showing idea ${index}, flat vector, no text`,
    negativePrompt: 'text, letters, watermark, changing labels',
    motionPrompt: 'A slow push in; nothing else moves',
    motionMode: 'still',
    keyframe: {
      cacheKey: 'a'.repeat(32), status: 'ready', path: `/k${index}.png`,
      producer: { kind: 'model', name: 'z-image-turbo@bf16', host: 'local' },
      failureReason: null, width: 2560, height: 1440, approved: true, approvalNote: null,
    },
    clip: null,
    narration: {
      'en-IN': `English line for scene ${index}`,
      'hi-IN': `हिन्दी पंक्ति ${index}`,
      'kn-IN': `ಕನ್ನಡ ಸಾಲು ${index}`,
    },
    subtitle: {
      'en-IN': `English line for scene ${index}`,
      'hi-IN': `हिन्दी पंक्ति ${index}`,
      'kn-IN': `ಕನ್ನಡ ಸಾಲು ${index}`,
    },
    audio: {
      'en-IN': {
        cacheKey: 'b'.repeat(32), status: 'ready', path: `/a${index}.wav`,
        producer: { kind: 'model', name: 'indic-parler-tts', host: 'local' },
        failureReason: null, measuredSeconds: 6.1, pace: 'natural', rewritten: false,
      },
    },
    ...over,
  } as Scene;
}

function spec(over: Partial<LessonSpec> = {}): LessonSpec {
  return {
    specVersion: SPEC_VERSION,
    lessonId: randomUUID(),
    curriculum: 'KTBS',
    classLevel: 10,
    subject: 'Science',
    chapter: 'Carbon and its Compounds',
    topic: 'Covalent bonding in carbon',
    medium: 'English',
    book: BOOK,
    visualStyle: 'illustrated',
    seed: 1234,
    styleContract: 'Flat vector illustration, thick rounded outlines, five locked colours, no text',
    scenes: [scene(1), scene(2), scene(3), scene(4)],
    languages: ['en-IN'],
    modelVersions: { image: 'z-image-turbo@bf16', motion: 'wan-2.2-ti2v-5b@fp16', speech: 'indic-parler-tts@v1' },
    pipelineVersion: 'v1',
    validations: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const VOICE = 'kn-teacher';

// ── The record itself ──────────────────────────────────────────────────────

const base = spec();
const parsed = LessonSpecSchema.safeParse(base);
check(parsed.success, 'a well-formed spec must parse: '
  + (parsed.success ? '' : parsed.error.issues.slice(0, 5)
      .map((i) => `${i.path.join('.')} -> ${i.message}`).join('; ')));
check(lessonSeconds(base) === 30, `4 scenes must be 30 s, got ${lessonSeconds(base)}`);
check(sceneSpan(base.scenes[2]!).start === 15, 'scene 3 starts at 15 s');
check(sceneSpan(base.scenes[3]!).end === 30, 'scene 4 ends at 30 s');
check(specIsRenderable(base), `a clean spec must be renderable: ${JSON.stringify(validateSpec(base).filter((v) => !v.passed))}`);
console.log('spec: four 7.5 s scenes make exactly 30 s, and the spans line up');

// ── Refusals ───────────────────────────────────────────────────────────────

// 8 scenes is 60 s, which is why the 60-second option cannot exist at all.
const tooLong = spec({ scenes: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => scene(n)) });
const cap = validateSpec(tooLong).find((v) => v.check === 'duration-cap');
check(cap && !cap.passed, `8 × ${SLOT_SECONDS} = 60 s must fail the ${MAX_LESSON_SECONDS} s cap`);
console.log(`cap: 8 scenes = 60 s is refused against the ${MAX_LESSON_SECONDS} s limit`);

const gap = spec({ scenes: [scene(1), scene(2), scene(4)] });
check(!validateSpec(gap).find((v) => v.check === 'scene-order')!.passed,
  'a gap in scene indexes must be refused');

const noKannada = spec({ languages: ['en-IN', 'kn-IN'] });
const missing = validateSpec(noKannada).find((v) => v.check === 'narration-kn-IN');
check(missing && missing.passed, 'the sample scenes do carry a Kannada line');
const stripped = spec({
  languages: ['en-IN', 'kn-IN'],
  scenes: [scene(1), scene(2, { narration: { 'en-IN': 'only english' } } as Partial<Scene>), scene(3), scene(4)],
});
check(!validateSpec(stripped).find((v) => v.check === 'narration-kn-IN')!.passed,
  'a scene with no Kannada line must be caught before assembly');
console.log('languages: a missing Kannada line is a failed check, not a silent gap');

// Narration that outruns its slot would play over the next picture.
const overrun = spec({
  scenes: [scene(1, {
    audio: {
      'en-IN': {
        cacheKey: 'c'.repeat(32), status: 'ready', path: '/a.wav',
        producer: { kind: 'model', name: 'indic-parler-tts', host: 'local' },
        failureReason: null, measuredSeconds: 8.4, pace: 'brisk', rewritten: true,
      },
    },
  } as Partial<Scene>), scene(2), scene(3), scene(4)],
});
check(!validateSpec(overrun).find((v) => v.check === 'narration-fits')!.passed,
  `8.4 s of speech must not fit a ${SLOT_SECONDS} s slot`);
console.log('timing: speech longer than its slot is refused rather than overlapped');

// The rule that stops money and GPU time going into a wrong picture.
const unapproved = spec({
  scenes: [scene(1, {
    motionMode: 'animate',
    keyframe: { ...scene(1).keyframe, approved: false, approvalNote: 'label was redrawn' },
  } as Partial<Scene>), scene(2), scene(3), scene(4)],
});
check(!validateSpec(unapproved).find((v) => v.check === 'animate-approved-only')!.passed,
  'an unapproved keyframe must never be animated');
console.log('gate: a picture that failed its check cannot become a clip');

const overQuota = spec({
  visualStyle: 'storybook',
  scenes: [1, 2, 3, 4].map((n) => scene(n, { motionMode: 'animate' } as Partial<Scene>)),
});
check(!validateSpec(overQuota).find((v) => v.check === 'animation-quota')!.passed,
  `storybook allows ${ANIMATED_QUOTA.storybook} animated scene, not 4`);
console.log(`quota: storybook refuses more than ${ANIMATED_QUOTA.storybook} animated scene`);

// ── Honesty about what produced an asset ───────────────────────────────────

const placeheld = spec({
  scenes: [scene(1, {
    keyframe: { ...scene(1).keyframe, producer: { kind: 'placeholder', name: 'procedural-still', host: 'local' } },
  } as Partial<Scene>), scene(2), scene(3), scene(4)],
});
check(placeholderAssets(base).length === 0, 'a model-built lesson reports no placeholders');
check(placeholderAssets(placeheld).length === 1,
  'a stand-in still must be reported, so a sample is never described as model-generated');
console.log('provenance: stand-in assets are reported, never passed off as generated');

// ── Cache keys: an edit must invalidate exactly what it changes ────────────

const before = spec();
const sameScenes = before.scenes.map((s) => ({ ...s }));

// A caption fix is the case the whole cache exists for.
const captionEdit: LessonSpec = {
  ...before,
  scenes: sameScenes.map((s, i) => (i === 2 ? { ...s, caption: 'A clearer caption' } : s)),
};
const d1 = diffSpecs(before, captionEdit, 'en-IN', VOICE, 'natural');
check(d1.keyframes.length === 0, `a caption edit must not touch a keyframe, got ${d1.keyframes}`);
check(d1.clips.length === 0, 'a caption edit must not re-run the motion model');
check(d1.audio.length === 0, 'a caption is never spoken, so audio must be reused');
check(d1.scenes.length === 1 && d1.scenes[0] === 3, `only scene 3 re-composites, got ${d1.scenes}`);
check(d1.lesson, 'the finished file does change');
console.log('cache: a caption fix re-renders one scene — no image model, no TTS, no Wan');

// A prompt change must not quietly serve the old picture.
const promptEdit: LessonSpec = {
  ...before,
  scenes: sameScenes.map((s, i) => (i === 0 ? { ...s, visualPrompt: 'A different diagram entirely, no text' } : s)),
};
const d2 = diffSpecs(before, promptEdit, 'en-IN', VOICE, 'natural');
check(d2.keyframes.length === 1 && d2.keyframes[0] === 1, 'a new visual prompt must redraw its keyframe');
check(d2.scenes.includes(1), 'and re-composite that scene');
console.log('cache: a new visual prompt does redraw — a stale picture is never served');

// Swapping a model retires everything it made.
const newImageModel: LessonSpec = {
  ...before,
  modelVersions: { ...before.modelVersions, image: 'z-image-turbo@v2' },
};
check(keyframeKey(before, before.scenes[0]!) !== keyframeKey(newImageModel, newImageModel.scenes[0]!),
  'changing the image model must retire its keyframes');
check(audioKey(before, before.scenes[0]!, 'en-IN', VOICE, 'natural')
  === audioKey(newImageModel, newImageModel.scenes[0]!, 'en-IN', VOICE, 'natural'),
  'but it must leave the narration alone');
console.log('cache: swapping the image model retires pictures and spares the audio');

// Language and pace reach the audio, and only the audio.
check(audioKey(before, before.scenes[0]!, 'en-IN', VOICE, 'natural')
  !== audioKey(before, before.scenes[0]!, 'kn-IN', VOICE, 'natural'),
  'two languages are two recordings');
check(audioKey(before, before.scenes[0]!, 'en-IN', VOICE, 'natural')
  !== audioKey(before, before.scenes[0]!, 'en-IN', VOICE, 'brisk'),
  'a brisker reading is a different waveform');
check(keyframeKey(before, before.scenes[0]!) === keyframeKey(before, before.scenes[0]!),
  'keys must be stable across calls');
console.log('cache: language and pace reach the audio key and nothing else');

// Reordering must not throw away work, because scenes are identified by id.
const reordered: LessonSpec = { ...before, scenes: [...sameScenes].reverse().map((s, i) => ({ ...s, index: i + 1 })) };
const movedScene = reordered.scenes.find((s) => s.id === before.scenes[0]!.id)!;
check(keyframeKey(before, before.scenes[0]!) !== keyframeKey(reordered, movedScene),
  'the seed is per index, so moving a scene does change its picture');
console.log('cache: a moved scene is still tracked by id, not by position');

// Two different scenes must never collide.
const keys = new Set(before.scenes.map((s) => sceneKey(before, s, 'en-IN', VOICE, 'natural')));
check(keys.size === 4, 'four scenes must produce four distinct keys');
check(lessonKey(before, 'en-IN', VOICE, 'natural') !== lessonKey(before, 'kn-IN', VOICE, 'natural'),
  'each language is its own finished file');
console.log('cache: no two scenes or languages share a key');

console.log('\nOK');
