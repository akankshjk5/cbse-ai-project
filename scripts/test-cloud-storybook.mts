/**
 * Offline tests for the storybook style's skills and contracts — no network,
 * no cost, no database.
 *
 *   npm run test:cloud-storybook
 *
 * Covers the storybook director's answer (shape, clean-up, the rules code
 * enforces), how it merges into the scene list the database accepts, the
 * animation cap, the picture checker's decision, and one round trip through
 * the real skill with a fake Gemini transport.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { wavDurationSeconds } from '../src/lib/cloud-lesson/audio.ts';
import { type GeminiRequest, type GeminiResponse, type GeminiTransport, generateStructured, toGeminiSchema } from '../src/lib/cloud-lesson/gemini.ts';
import { type CloudImageStore, type ImageJob, needsStyleReference, runCloudImageJob, STORYBOOK_REFERENCE_INSTRUCTION } from '../src/lib/cloud-lesson/image-worker.ts';
import { prepareCloudLesson } from '../src/lib/cloud-lesson/prepare.ts';
import sharp from 'sharp';
import { loadCloudLessonSkill, renderCloudLessonPrompt } from '../src/lib/cloud-lesson/skills.ts';
import {
  cleanChapterTitle,
  CloudLessonStorybookSceneSchema,
  decideStorybookShot,
  mergeStorybookScenes,
  normalizeCameraMove,
  storybookDirectionSchema,
  storybookShotCount,
  type StorybookVerdict,
} from '../src/lib/cloud-lesson/storybook.ts';

let passed = 0;
async function test(name: string, body: () => Promise<void> | void) {
  await body();
  passed += 1;
  console.log(`ok  ${name}`);
}

const SIZES = ['wide', 'close', 'detail'] as const;
const MOVES = ['pan_right', 'push_in', 'tilt_up'] as const;
const PLACES = ['stone gateway', 'crowded courtyard', 'hilltop fort', 'river ghat', 'palace hall', 'market lane', 'forest path', 'night camp'];

function scene(index: number, shots = 2, motionMode: 'animate' | 'still' = 'still') {
  return {
    index,
    title: `Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][index - 1]}`,
    motionMode,
    motionDescription: 'Start: porters stand at the gate. Then: they walk forward slowly. End: they pass under the arch.',
    shots: Array.from({ length: shots }, (_, s) => ({
      shotSize: SIZES[s],
      cameraMove: MOVES[s],
      visualDescription: `Shot ${s + 1} of scene ${index}: two porters carry a covered wicker basket past the ${PLACES[index - 1]}, guards watching with tall spears.`,
    })),
  };
}
function direction(count = 8, animate: number[] = [1, 4], shotsFor = (_i: number) => 2) {
  return {
    visualBible: 'Shivaji Maharaj: tall, trimmed beard, pointed turban, long angarkha. Porters: barefoot, dhotis. Guards: helmets, tall spears.',
    scenes: Array.from({ length: count }, (_, i) => scene(i + 1, shotsFor(i + 1), animate.includes(i + 1) ? 'animate' : 'still')),
  };
}
const written = (count = 8) => Array.from({ length: count }, (_, i) => ({
  index: i + 1,
  fact: 'Shivaji Maharaj escaped from Agra hidden in a basket of sweets.',
  narration: 'Shivaji Maharaj slipped out of Agra hidden inside a basket of sweets.',
  caption: 'The escape',
  overlay: { kind: 'none' as const },
}));

const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

// ── Director answer ─────────────────────────────────────────────────────────

await test('director: a well-formed answer passes', () => {
  const parsed = storybookDirectionSchema(8).safeParse(direction());
  assert.deepEqual(issues(parsed), []);
  assert.equal(storybookShotCount(parsed.data!), 16);
});

await test('director: camera moves and titles are cleaned, lettering-prone phrases rewritten', () => {
  assert.equal(normalizeCameraMove('Push in'), 'push_in');
  assert.equal(normalizeCameraMove('zoom-out'), 'pull_out');
  assert.equal(normalizeCameraMove('PAN_LEFT'), 'pan_left');
  assert.equal(cleanChapterTitle('"The Grand Bazaar."'), 'The Grand Bazaar');
  assert.equal(cleanChapterTitle('Shivaji’s Escape!'), "Shivaji's Escape");
  const answer = direction();
  answer.scenes[0].shots[0].cameraMove = 'Zoom in' as never;
  answer.scenes[0].title = 'A Daring Plan.';
  answer.scenes[1].shots[1].visualDescription = 'A close view of a printed circuit board glowing softly on a wooden workbench in the camp tent.';
  const parsed = storybookDirectionSchema(8).safeParse(answer);
  assert.deepEqual(issues(parsed), []);
  assert.equal(parsed.data!.scenes[0].shots[0].cameraMove, 'push_in');
  assert.equal(parsed.data!.scenes[0].title, 'A Daring Plan');
  assert.match(parsed.data!.scenes[1].shots[1].visualDescription, /a circuit board/);
});

await test('director: exactly 2 shots per scene — 1 or 3 are refused', () => {
  const one = direction(); one.scenes[2].shots = one.scenes[2].shots.slice(0, 1);
  assert.ok(issues(storybookDirectionSchema(8).safeParse(one)).length > 0);
  const three = direction(); three.scenes[2].shots = [...three.scenes[2].shots, { ...three.scenes[3].shots[0], shotSize: 'detail' }];
  assert.ok(issues(storybookDirectionSchema(8).safeParse(three)).some((m) => /<=2/.test(m)));
});

await test('director: a scene must move between shot sizes, and no picture may repeat', () => {
  const same = direction(); same.scenes[1].shots[1].shotSize = 'wide';
  assert.ok(issues(storybookDirectionSchema(8).safeParse(same)).some((m) => /different shot size/.test(m)));
  const repeated = direction(); repeated.scenes[5].shots[1].visualDescription = repeated.scenes[2].shots[0].visualDescription;
  assert.ok(issues(storybookDirectionSchema(8).safeParse(repeated)).some((m) => /new picture/.test(m)));
});

await test('director: pictures may not name writing or the objects that carry it', () => {
  for (const visual of [
    'A scholar unrolls a long scroll on a low wooden desk beside an oil lamp in a quiet room.',
    'A royal procession passes under a silk banner strung between two carved stone pillars.',
    'Two traders lean over a large map spread across a table in a candle-lit merchant house.',
    'A messenger hands a sealed letters bundle to a guard at the outer gate of the fort.',
  ]) {
    const answer = direction(); answer.scenes[0].shots[1].visualDescription = visual;
    assert.ok(issues(storybookDirectionSchema(8).safeParse(answer)).some((m) => /writing/.test(m)), visual);
  }
});

await test('director: titles are 2-4 plain words; motion is Start/Then/End; scenes in order', () => {
  const digits = direction(); digits.scenes[0].title = 'Year 1666 Escape';
  assert.ok(issues(storybookDirectionSchema(8).safeParse(digits)).some((m) => /digits/.test(m)));
  const long = direction(); long.scenes[0].title = 'How Shivaji Maharaj Escaped From Agra';
  assert.ok(issues(storybookDirectionSchema(8).safeParse(long)).some((m) => /2-4 words/.test(m)));
  const motion = direction(); motion.scenes[0].motionDescription = 'The porters walk slowly past the guards and out of the gate.';
  assert.ok(issues(storybookDirectionSchema(8).safeParse(motion)).some((m) => /Start/.test(m)));
  const order = direction(); order.scenes[3].index = 9;
  assert.ok(issues(storybookDirectionSchema(8).safeParse(order)).length > 0);
  assert.ok(issues(storybookDirectionSchema(4).safeParse(direction(8))).length > 0, '8 scenes for a 4-scene lesson');
});

await test('director: the response schema converts for Gemini', () => {
  const schema = toGeminiSchema(storybookDirectionSchema(8));
  assert.equal(schema.type, 'object');
  assert.ok(JSON.stringify(schema).includes('cameraMove'));
});

// ── Merge into the database's scene list ────────────────────────────────────

await test('merge: first shot becomes the scene visual; output matches the database contract', () => {
  const { scenes, demotedToStill } = mergeStorybookScenes(written(), storybookDirectionSchema(8).parse(direction()));
  assert.equal(scenes.length, 8);
  assert.deepEqual(demotedToStill, []);
  for (const merged of scenes) {
    assert.equal(merged.visualDescription, merged.shots[0].visualDescription);
    assert.ok(CloudLessonStorybookSceneSchema.safeParse(merged).success);
  }
  assert.deepEqual(scenes.filter((s) => s.motionMode === 'animate').map((s) => s.index), [1, 4]);
});

await test('merge: the animation cap is enforced in scene order (2 of 8, 1 of 4)', () => {
  const eight = mergeStorybookScenes(written(8), storybookDirectionSchema(8).parse(direction(8, [1, 2, 3, 5, 8])));
  assert.deepEqual(eight.scenes.filter((s) => s.motionMode === 'animate').map((s) => s.index), [1, 2]);
  assert.deepEqual(eight.demotedToStill, [3, 5, 8]);
  const four = mergeStorybookScenes(written(4), storybookDirectionSchema(4).parse(direction(4, [2, 3, 4])));
  assert.deepEqual(four.scenes.filter((s) => s.motionMode === 'animate').map((s) => s.index), [2]);
  assert.deepEqual(four.demotedToStill, [3, 4]);
});

await test('merge: a direction for the wrong number of scenes is an error', () => {
  assert.throws(() => mergeStorybookScenes(written(4), storybookDirectionSchema(8).parse(direction(8))), /8 scenes for a 4-scene/);
});

// ── Picture checker decision ────────────────────────────────────────────────

const good: StorybookVerdict = { showsSubject: true, singlePhoto: true, hasWriting: false, matchesStyle: true, unsafe: false, reason: 'Fine.' };
await test('checker: writing and unsafe imagery are never accepted; the rest only on the last attempt', () => {
  assert.equal(decideStorybookShot(good, false).accept, true);
  assert.equal(decideStorybookShot({ ...good, matchesStyle: false }, false).accept, false);
  assert.equal(decideStorybookShot({ ...good, matchesStyle: false }, true).acceptedOnFinalAttempt, true);
  assert.equal(decideStorybookShot({ ...good, singlePhoto: false }, true).accept, true);
  assert.equal(decideStorybookShot({ ...good, hasWriting: true }, true).accept, false);
  assert.equal(decideStorybookShot({ ...good, unsafe: true }, true).accept, false);
  assert.deepEqual(decideStorybookShot({ ...good, showsSubject: false, matchesStyle: false }, false).problems,
    ['subject not shown', 'not in the engraving style']);
});

// ── One round trip through the real skill ───────────────────────────────────

await test('skill: the real director prompt renders, and a repeated shot size is sent back as a correction', async () => {
  const skill = await loadCloudLessonSkill('cloud-lesson-storybook-director');
  const values = { sceneCount: 8, classLevel: 7, subject: 'History', animationCap: 2, shotsPerScene: 2 };
  assert.match(renderCloudLessonPrompt(skill, values), /Class 7 History/);
  const bad = direction(); bad.scenes[0].shots[1].shotSize = 'wide';
  const answers = [bad, direction()];
  const requests: GeminiRequest[] = [];
  const transport: GeminiTransport = {
    async generateContent(request) {
      requests.push(structuredClone(request));
      return {
        candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift()) }] } }],
        usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 4000, thoughtsTokenCount: 1500 },
      } satisfies GeminiResponse;
    },
  };
  const result = await generateStructured({
    skill, values, transport, retryDelaysMs: [0, 0], maxRetryWaitMs: 0,
    userPrompt: 'Direct this lesson.', schema: storybookDirectionSchema(8), maxAttempts: 3,
  });
  assert.equal(result.attempts, 2);
  assert.match(JSON.stringify(requests[1].contents.at(-1)), /different shot size/);
  assert.deepEqual(requests[0].config.thinkingConfig, { thinkingLevel: 'MEDIUM' });
  assert.equal(storybookShotCount(result.data), 16);
});

// ── The prep pipeline's storybook branch (fake Gemini, no network) ─────────

const TOPICS = ['the summons', 'the court', 'the mansion', 'the guards', 'the bazaar', 'the baskets', 'the ride', 'the return'];
const writtenPlan = (count = 8) => ({
  title: 'Escape from Agra', learningObjective: 'Explain how Shivaji Maharaj escaped from house arrest in Agra.',
  scenes: TOPICS.slice(0, count).map((topic, i) => ({
    index: i + 1, fact: `Shivaji Maharaj's escape from Agra included ${topic} in its story.`,
    narration: `This part of the escape from Agra is the story of ${topic} told plainly.`,
    caption: `Story of ${topic.split(' ')[1]}`, overlay: { kind: 'none' },
  })),
});
const reply = (data: unknown): GeminiResponse => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 },
});
function voice(seconds = 1.2): GeminiResponse {
  const pcm = Buffer.alloc(Math.round(seconds * 24_000) * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / 24_000)), i * 2);
  return {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 30 }] },
  };
}
const ROLES = [['Lesson Writer', 'writer'], ['Fact Auditor', 'auditor'], ['Math Repair', 'repair'], ['Scene Director', 'director'],
  ['Storybook Director', 'storybook'], ['Translator', 'translator'], ['Narration Editor', 'editor']] as const;
const roleOf = (request: GeminiRequest) => ROLES.find(([label]) => String(request.config.systemInstruction ?? '').includes(`**${label}**`))?.[1] ?? 'tts';
const HINDI = { narration: 'शिवाजी महाराज आगरा से बड़ी चतुराई के साथ बाहर निकल गए।', short: 'साहसी योजना' };
const KANNADA = { narration: 'ಶಿವಾಜಿ ಮಹಾರಾಜರು ಆಗ್ರಾದಿಂದ ಬಹಳ ಜಾಣ್ಮೆಯಿಂದ ಹೊರಬಂದರು।', short: 'ಧೈರ್ಯದ ಯೋಜನೆ' };
function lessonFake(options: { count?: number; animate?: number[]; language?: typeof HINDI; translate?: (id: string, text: string) => string } = {}) {
  const count = options.count ?? 8;
  const calls: { role: string; request: GeminiRequest }[] = [];
  const transport: GeminiTransport = {
    async generateContent(request) {
      const role = roleOf(request);
      calls.push({ role, request: structuredClone(request) });
      if (role === 'writer') return reply(writtenPlan(count));
      if (role === 'auditor') return reply({ scenes: writtenPlan(count).scenes.map((s) => ({ index: s.index, fact: s.fact, narration: s.narration, verdict: 'correct' })) });
      if (role === 'storybook') return reply(direction(count, options.animate ?? [1, 2, 4, 6, 8]));
      if (role === 'translator') {
        const items = JSON.parse(String(request.contents[0].parts[0].text)) as { id: string; kind: string; text: string }[];
        const language = options.language ?? HINDI;
        return reply({ translations: items.map((item) => ({ id: item.id,
          text: options.translate?.(item.id, item.text) ?? (item.kind === 'narration' ? language.narration : language.short) })) });
      }
      if (role === 'tts') return voice();
      throw new Error(`no fake answer for ${role}`);
    },
  };
  return { calls, transport };
}
const lessonInput = { classLevel: 7, subject: 'History', topic: 'Escape from Agra', languageCode: 'en-IN' as const, visualStyle: 'storybook' as const };
const quiet = { referenceLookup: async () => null, retryDelaysMs: [], maxRetryWaitMs: 0 };
type StoryScene = { title?: string; shots?: { visualDescription: string }[]; visualDescription: string; motionMode: string };

await test('prepare: an English storybook lesson has titles, 2 shots per scene, the storyteller voice and the 2-scene cap', async () => {
  const fake = lessonFake();
  const lesson = await prepareCloudLesson({ input: lessonInput, transport: fake.transport, ...quiet });
  const scenes = lesson.scenes as StoryScene[];
  assert.equal(scenes.length, 8);
  assert.ok(scenes.every((scene) => scene.title && scene.shots && scene.shots.length >= 2 && scene.shots.length <= 3));
  assert.ok(scenes.every((scene) => scene.visualDescription === scene.shots![0].visualDescription));
  assert.deepEqual(scenes.flatMap((scene, i) => (scene.motionMode === 'animate' ? [i + 1] : [])), [1, 2]);
  assert.deepEqual(lesson.metadata.storybook, { shotCount: 16, demotedToStill: [4, 6, 8] });
  assert.equal(lesson.metadata.sourcePlan?.storybook?.length, 8);
  assert.equal(wavDurationSeconds(lesson.narration.wav), 60);
  assert.ok(!fake.calls.some((call) => call.role === 'director'), 'the existing scene director is not used');
  assert.ok(!fake.calls.some((call) => call.role === 'translator'), 'English needs no translation');
  const styles = fake.calls.filter((call) => call.role === 'tts')
    .map((call) => (call.request.contents[0].parts[0] as { speechMetadata?: { style?: string } }).speechMetadata?.style ?? '');
  assert.equal(styles.length, 8);
  assert.ok(styles.every((style) => /storyteller/.test(style)));
  const director = fake.calls.find((call) => call.role === 'storybook')!;
  assert.match(String(director.request.config.systemInstruction), /exactly 2 \*\*shots\*\*/);
  assert.match(String(director.request.config.systemInstruction), /at most 2 of the\s+8/);
});

await test('prepare: a Hindi 30-second storybook lesson translates chapter titles like captions; shots stay English', async () => {
  const fake = lessonFake({ count: 4, animate: [2, 3, 4] });
  const lesson = await prepareCloudLesson({ input: { ...lessonInput, languageCode: 'hi-IN', durationSeconds: 30 }, transport: fake.transport, ...quiet });
  const scenes = lesson.scenes as StoryScene[];
  assert.equal(scenes.length, 4);
  assert.ok(scenes.every((scene) => scene.title === HINDI.short));
  assert.ok(scenes.every((scene) => /porters/.test(scene.shots![0].visualDescription)));
  assert.deepEqual(scenes.flatMap((scene, i) => (scene.motionMode === 'animate' ? [i + 1] : [])), [2]);
  const items = JSON.parse(String(fake.calls.find((call) => call.role === 'translator')!.request.contents[0].parts[0].text)) as { id: string; kind: string }[];
  assert.deepEqual(items.filter((item) => item.id.startsWith('chapter-')).map((item) => item.kind), ['caption', 'caption', 'caption', 'caption']);
  assert.equal(wavDurationSeconds(lesson.narration.wav), 30);
});

await test('prepare: a chapter title translated too long is sent back for correction', async () => {
  let first = true;
  const fake = lessonFake({ count: 4, translate: (id) => {
    if (id === 'chapter-2' && first) { first = false; return 'साहसी योजना '.repeat(6).trim(); }
    return undefined as unknown as string;
  } });
  const lesson = await prepareCloudLesson({ input: { ...lessonInput, languageCode: 'hi-IN', durationSeconds: 30 }, transport: fake.transport, ...quiet });
  assert.equal(fake.calls.filter((call) => call.role === 'translator').length, 2);
  assert.match(JSON.stringify(fake.calls.filter((call) => call.role === 'translator')[1].request.contents.at(-1)), /at most (5 words|60 characters)/);
  assert.equal((lesson.scenes as StoryScene[])[1].title, HINDI.short);
});

await test('prepare: a reused storybook plan rebuilds titles and shots in another language with no writer or director call', async () => {
  const original = await prepareCloudLesson({ input: lessonInput, transport: lessonFake().transport, ...quiet });
  const fake = lessonFake({ language: KANNADA });
  const reused = await prepareCloudLesson({ input: { ...lessonInput, languageCode: 'kn-IN' }, transport: fake.transport, ...quiet,
    sourcePlan: original.metadata.sourcePlan,
    referenceLookup: async () => { throw new Error('reuse must not research again'); } });
  assert.deepEqual(fake.calls.map((call) => call.role).filter((role) => role !== 'tts'), ['translator']);
  const scenes = reused.scenes as StoryScene[];
  assert.ok(scenes.every((scene) => scene.title === KANNADA.short));
  assert.deepEqual(scenes.map((scene) => scene.shots), (original.scenes as StoryScene[]).map((scene) => scene.shots));
  assert.deepEqual(scenes.map((scene) => scene.motionMode), (original.scenes as StoryScene[]).map((scene) => scene.motionMode));
});

await test('prepare: a storybook reuse whose source has no shots is refused before any spend', async () => {
  const original = await prepareCloudLesson({ input: lessonInput, transport: lessonFake().transport, ...quiet });
  const { storybook: _dropped, ...withoutShots } = original.metadata.sourcePlan!;
  void _dropped;
  const fake = lessonFake();
  await assert.rejects(prepareCloudLesson({ input: lessonInput, transport: fake.transport, ...quiet, sourcePlan: withoutShots }), /no storybook shots/);
  assert.equal(fake.calls.length, 0);
});

await test('prepare: the existing styles are unchanged — teacher voice, scene director, no titles or shots', async () => {
  const calls: string[] = [];
  const styles: string[] = [];
  const transport: GeminiTransport = {
    async generateContent(request) {
      const role = roleOf(request);
      calls.push(role);
      if (role === 'writer') return reply(writtenPlan());
      if (role === 'auditor') return reply({ scenes: writtenPlan().scenes.map((s) => ({ index: s.index, fact: s.fact, narration: s.narration, verdict: 'correct' })) });
      if (role === 'director') return reply({ visualBible: 'Plain clay figures of travellers and guards, matte finish, consistent size.',
        scenes: TOPICS.map((topic, i) => ({ index: i + 1, subject: `the escape from Agra ${topic}`,
          visualDescription: `Clay figures act out the escape from Agra: ${topic}, arranged on a plain clay platform, scene ${i + 1}.`,
          motionDescription: 'Start: the figures stand still. Then: they move slowly forward. End: they settle in place.', motionMode: 'still' })) });
      if (role === 'tts') {
        styles.push((request.contents[0].parts[0] as { speechMetadata?: { style?: string } }).speechMetadata?.style ?? '');
        return voice();
      }
      throw new Error(`no fake answer for ${role}`);
    },
  };
  const lesson = await prepareCloudLesson({ input: { ...lessonInput, visualStyle: 'illustrated' }, transport, ...quiet });
  assert.ok(calls.includes('director') && !calls.includes('storybook'));
  assert.ok(styles.every((style) => /teacher/.test(style) && !/storyteller/.test(style)));
  assert.ok((lesson.scenes as StoryScene[]).every((scene) => scene.title === undefined && scene.shots === undefined));
  assert.equal(lesson.metadata.storybook, undefined);
  assert.equal(lesson.metadata.sourcePlan?.storybook, undefined);
});

// ── The image worker's storybook shots (fake Gemini and store) ─────────────

const keyframePng = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: '#e9dfc8' } }).png().toBuffer();
const shotJob = (sceneIndex: number, shotIndex: number, extra: Partial<ImageJob> = {}): ImageJob => ({
  id: '11111111-1111-4111-8111-111111111111', project_id: '22222222-2222-4222-8222-222222222222',
  scene_id: '33333333-3333-4333-8333-333333333333', shot_id: '44444444-4444-4444-8444-444444444444',
  owner_id: 'user_test', kind: 'image', status: 'processing', worker_id: 'test', attempts: 1, max_attempts: 3,
  prompt: 'Two porters carry a covered wicker basket through a stone gateway. Black-and-white pen-and-ink engraving illustration.',
  negative_prompt: 'text, colour, photorealistic',
  parameters: { sceneIndex, shotIndex, shotSize: 'wide', visualStyle: 'storybook',
    ...(sceneIndex === 1 && shotIndex === 1 ? {} : { styleReferenceUrl: 'https://storage.test/s1-1.png' }) },
  ...extra,
});
async function drawShot(job: ImageJob, verdict: Partial<StorybookVerdict> = {}) {
  const roles: string[] = [];
  let referenceText = '';
  let metadata: Record<string, unknown> = {};
  const outcome = { uploads: 0, references: 0, failures: [] as string[] };
  const transport: GeminiTransport = {
    async generateContent(request) {
      if ((request.config.responseModalities as string[] | undefined)?.includes('IMAGE')) {
        roles.push('image');
        referenceText = request.contents[0].parts.map((part) => ('text' in part ? part.text : '')).join(' | ');
        return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: keyframePng.toString('base64') } }] } }],
          usageMetadata: { candidatesTokenCount: 1680, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1680 }] } };
      }
      const system = String(request.config.systemInstruction ?? '');
      roles.push(system.includes('**Storybook Checker**') ? 'storybook-checker' : system.includes('**Keyframe Checker**') ? 'keyframe-checker' : 'other');
      return { candidates: [{ content: { parts: [{ text: JSON.stringify({ ...good, ...verdict, ...(system.includes('**Keyframe Checker**') ? { matchesStyle: undefined } : {}) }) }] } }] };
    },
  };
  const store: CloudImageStore = {
    async claim() { return job; },
    async scene() { return { index: job.parameters.sceneIndex, description: 'Two porters carry a covered basket through a gateway.', shotIndex: job.parameters.shotIndex }; },
    async reference() { outcome.references += 1; return { mimeType: 'image/png', data: keyframePng }; },
    async heartbeat() { return 'ok'; },
    async upload() { outcome.uploads += 1; return 'https://storage.test/shot.png'; },
    async complete(_job, _url, data) { metadata = data; return true; },
    async fail(_job, code) { outcome.failures.push(code); return true; },
  };
  const result = await runCloudImageJob({ job, store, transport, model: 'gemini-nano-banana-2.1', retryDelaysMs: [], heartbeatMs: 1000 });
  return { result, roles, referenceText, metadata, ...outcome };
}

await test('image: shot 1 of scene 1 is drawn without a reference and checked by the storybook checker', async () => {
  const run = await drawShot(shotJob(1, 1));
  assert.equal(run.result.status, 'completed');
  assert.equal(run.references, 0);
  assert.deepEqual(run.roles, ['image', 'storybook-checker']);
  assert.equal(run.metadata.visualStyle, 'storybook');
  assert.equal(run.metadata.shotIndex, 1);
  assert.equal(run.metadata.styleReferenceUsed, false);
});

await test('image: every other shot needs the reference — even shot 2 of scene 1 — and copies its engraving look', async () => {
  assert.equal(needsStyleReference(shotJob(1, 2)), true);
  assert.equal(needsStyleReference(shotJob(1, 1)), false);
  const missing = shotJob(1, 2); delete (missing.parameters as { styleReferenceUrl?: string }).styleReferenceUrl;
  const refused = await drawShot(missing);
  assert.equal(refused.result.status, 'failed');
  assert.equal(refused.roles.length, 0, 'no paid call without the reference');
  const later = await drawShot(shotJob(5, 2));
  assert.equal(later.result.status, 'completed');
  assert.equal(later.references, 1);
  assert.ok(later.referenceText.includes(STORYBOOK_REFERENCE_INSTRUCTION));
  assert.ok(!/photographic style/.test(later.referenceText));
});

await test('image: a shot that lost the engraving look is redrawn, and kept with a warning only on the last attempt', async () => {
  const early = await drawShot(shotJob(2, 1), { matchesStyle: false });
  assert.equal(early.result.status, 'failed');
  assert.deepEqual(early.failures, ['keyframe_rejected']);
  assert.equal(early.uploads, 0);
  const last = await drawShot(shotJob(2, 1, { attempts: 3 }), { matchesStyle: false });
  assert.equal(last.result.status, 'completed');
  assert.deepEqual(last.metadata.warnings, ['not in the engraving style']);
});

await test('image: a shot with writing is never kept, even on the last attempt', async () => {
  const run = await drawShot(shotJob(2, 2, { attempts: 3 }), { hasWriting: true });
  assert.equal(run.result.status, 'failed');
  assert.equal(run.uploads, 0);
});

await test('image: the existing styles still use the keyframe checker and the photographic reference wording', async () => {
  const sceneJob: ImageJob = { ...shotJob(2, 1), shot_id: null,
    prompt: 'A clear glass vessel of blue water on a clay platform. Clean 2D educational illustration.',
    parameters: { sceneIndex: 2, styleReferenceUrl: 'https://storage.test/s1.png' } };
  const run = await drawShot(sceneJob);
  assert.equal(run.result.status, 'completed');
  assert.deepEqual(run.roles, ['image', 'keyframe-checker']);
  assert.match(run.referenceText, /photographic style/);
  assert.equal(run.metadata.visualStyle, undefined);
});

// For the SQL rehearsal: write a merged plan the database can be fed directly.
if (process.argv.includes('--write-plan')) {
  const lesson = await prepareCloudLesson({ input: { ...lessonInput, languageCode: 'hi-IN' }, transport: lessonFake().transport, ...quiet });
  await writeFile(process.argv[process.argv.indexOf('--write-plan') + 1], JSON.stringify(lesson.scenes));
}

console.log(`cloud storybook: ${passed} tests passed; no API calls or database writes.`);
