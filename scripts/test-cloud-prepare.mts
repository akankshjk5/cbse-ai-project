/** Offline preparation + queue lifecycle tests. All Gemini/Wikipedia/Storage calls are fake. */
import assert from 'node:assert/strict';

import { wavDurationSeconds } from '../src/lib/cloud-lesson/audio.ts';
import { type GeminiRequest, type GeminiResponse, type GeminiTransport } from '../src/lib/cloud-lesson/gemini.ts';
import { prepareCloudLesson, type PreparedCloudLesson } from '../src/lib/cloud-lesson/prepare.ts';
import {
  type CloudPreparationStore, type HeartbeatState, type PrepareJob,
  preparationFailure, runCloudPreparationJob,
} from '../src/lib/cloud-lesson/worker.ts';

let passed = 0;
const test = async (name: string, body: () => Promise<void>) => {
  await body();
  passed += 1;
  console.log(`ok ${name}`);
};
const input = { classLevel: 6, subject: 'Science', topic: 'Water cycle', languageCode: 'en-IN' as const, visualStyle: 'editorial' as const };
const NO_WAIT = { retryDelaysMs: [], maxRetryWaitMs: 0 };
const noReference = async () => null;
const words = ['evaporation', 'condensation', 'rainfall', 'collection', 'rivers', 'oceans', 'clouds', 'sunlight'];
const written = () => ({
  title: 'The water cycle', learningObjective: 'Explain how water moves through the environment in a repeating cycle.',
  scenes: words.map((word, index) => ({
    index: index + 1, fact: `Water plays an important role in ${word} during its natural cycle.`,
    narration: `Water moves through the environment as part of the ${word} process.`,
    caption: `Water and ${word}`, overlay: { kind: 'none' },
  })),
});
const directed = () => ({
  visualBible: 'Clear glass vessels holding blue water; matte clay platforms with consistent proportions.',
  scenes: words.map((word, index) => ({
    index: index + 1, subject: 'water in a glass vessel',
    visualDescription: `A clear glass vessel filled with blue water stands beside a rounded clay mound shaped for ${word}.`,
    motionDescription: 'Start: water rests in the vessel. Then: water swirls gently within it. End: the water settles to a calm surface.',
    motionMode: 'animate',
  })),
});
const textAnswer = (data: unknown): GeminiResponse => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 },
});
function voiceAnswer(seconds = 1): GeminiResponse {
  const sampleRate = 24_000;
  const pcm = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / sampleRate)), i * 2);
  return {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: Math.ceil(seconds * 25), candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: Math.ceil(seconds * 25) }] },
  };
}
function skillOf(request: GeminiRequest) {
  const prompt = String(request.config.systemInstruction ?? '');
  for (const [label, name] of [['Lesson Writer', 'writer'], ['Fact Auditor', 'auditor'], ['Math Repair', 'repair'], ['Scene Director', 'director'], ['Translator', 'translator'], ['Narration Editor', 'editor']]) {
    if (prompt.includes(`**${label}**`)) return name;
  }
  return 'tts';
}
type Hook = (stage: string, request: GeminiRequest, count: number) => GeminiResponse | undefined | Promise<GeminiResponse | undefined>;
function fake(hook?: Hook) {
  const requests: { stage: string; request: GeminiRequest }[] = [];
  const transport: GeminiTransport = {
    async generateContent(request) {
      const stage = skillOf(request);
      requests.push({ stage, request: structuredClone(request) });
      const custom = await hook?.(stage, request, requests.filter((call) => call.stage === stage).length);
      if (custom) return custom;
      if (stage === 'writer') return textAnswer(written());
      if (stage === 'auditor') return textAnswer({ scenes: written().scenes.map((scene) => ({ index: scene.index, fact: scene.fact, narration: scene.narration, verdict: 'correct' })) });
      if (stage === 'director') return textAnswer(directed());
      if (stage === 'repair') return textAnswer({ scenes: [{ index: 1, fact: written().scenes[0].fact, overlay: { kind: 'none' } }] });
      if (stage === 'tts') return voiceAnswer();
      throw new Error(`No fake answer configured for ${stage}`);
    },
  };
  return { requests, transport };
}
const prepare = (transport: GeminiTransport, extra: Partial<Parameters<typeof prepareCloudLesson>[0]> = {}) => prepareCloudLesson({ input, transport, referenceLookup: noReference, ...NO_WAIT, ...extra });

await test('English lesson: eight ordered scenes, six animation cap, exact 60-second WAV', async () => {
  const fixture = fake();
  const result = await prepare(fixture.transport);
  assert.equal(result.scenes.length, 8);
  assert.equal(result.scenes.filter((scene) => scene.motionMode === 'animate').length, 6);
  assert.equal(result.narration.durationSeconds, 60);
  assert.equal(wavDurationSeconds(result.narration.wav), 60);
  assert.equal(result.narrationText, result.scenes.map((scene) => scene.narration).join(' '));
  assert.ok(result.costUsd > 0);
  assert.equal(result.metadata.cost.unpricedCalls, 0);
  assert.equal(fixture.requests.filter((call) => call.stage === 'tts').length, 8);
  assert.ok(!fixture.requests.some((call) => call.stage === 'translator'));
  assert.equal(result.metadata.reference, null);
});

for (const languageCode of ['en-IN', 'hi-IN', 'kn-IN'] as const) {
  await test(`30-second illustrated lesson: ${languageCode} has four scenes and matching captions`, async () => {
    const fixture = fake((stage, request) => {
      if (stage === 'writer') return textAnswer({ ...written(), scenes: written().scenes.slice(0, 4) });
      if (stage === 'auditor') return textAnswer({ scenes: written().scenes.slice(0, 4).map(s => ({ ...s, verdict: 'correct' })) });
      if (stage === 'director') return textAnswer({ ...directed(), scenes: directed().scenes.slice(0, 4) });
      if (stage === 'translator') {
        const items = JSON.parse(String(request.contents[0].parts[0].text)) as { id: string; kind: string }[];
        return textAnswer({ translations: items.map(item => ({ id: item.id, text: languageCode === 'hi-IN'
          ? (item.kind === 'narration' ? 'पानी प्रकृति में एक स्थान से दूसरे स्थान तक जाता है।' : 'पानी का चक्र')
          : (item.kind === 'narration' ? 'ನೀರು ಪ್ರಕೃತಿಯಲ್ಲಿ ಒಂದು ಸ್ಥಳದಿಂದ ಇನ್ನೊಂದು ಸ್ಥಳಕ್ಕೆ ಚಲಿಸುತ್ತದೆ।' : 'ನೀರಿನ ಚಕ್ರ') })) });
      }
      return undefined;
    });
    const result = await prepare(fixture.transport, { input: { ...input, durationSeconds: 30, visualStyle: 'illustrated', languageCode } });
    assert.equal(result.scenes.length, 4);
    assert.equal(result.scenes.filter(s => s.motionMode === 'animate').length, 2);
    assert.equal(wavDurationSeconds(result.narration.wav), 30);
    assert.ok(result.scenes.every(s => s.caption.length > 0));
    const reused = await prepare(fixture.transport, { input: { ...input, durationSeconds: 30, visualStyle: 'illustrated', languageCode }, sourcePlan: result.metadata.sourcePlan });
    assert.equal(reused.narration.durationSeconds, 30);
  });
}

await test('60-second illustrated presentation caps provider motion at three scenes', async () => {
  const result = await prepare(fake().transport, { input: { ...input, visualStyle: 'illustrated' } });
  assert.equal(result.scenes.filter(s => s.motionMode === 'animate').length, 3);
});

await test('Audited source reuse skips research, writing, auditing and visual direction', async () => {
  const original = await prepare(fake().transport);
  assert.ok(original.metadata.sourcePlan);
  const fixture = fake();
  const reused = await prepare(fixture.transport, { sourcePlan: original.metadata.sourcePlan,
    referenceLookup: async () => { throw new Error('Reuse must not research again'); } });
  assert.equal(reused.narration.durationSeconds, 60);
  assert.deepEqual(reused.metadata.sourcePlan, original.metadata.sourcePlan);
  assert.ok(fixture.requests.every(call => call.stage === 'tts'));
  assert.deepEqual(reused.scenes.map(s => s.visualDescription), original.scenes.map(s => s.visualDescription));
});

await test('Writer validation rejects missing scenes before narration', async () => {
  const fixture = fake((stage) => stage === 'writer' ? textAnswer({ ...written(), scenes: written().scenes.slice(0, 7) }) : undefined);
  await assert.rejects(prepare(fixture.transport), /valid answer/);
  assert.equal(fixture.requests.length, 3);
});

await test('Writer digits and wrong-language source trigger a correction', async () => {
  const fixture = fake((stage, _request, count) => {
    if (stage !== 'writer' || count !== 1) return undefined;
    const plan = written();
    plan.scenes[0].narration = 'Water travels 2 times through the environment in this natural process.';
    return textAnswer(plan);
  });
  await prepare(fixture.transport);
  const corrected = fixture.requests.filter((call) => call.stage === 'writer');
  assert.equal(corrected.length, 2);
  assert.match(JSON.stringify(corrected[1].request.contents), /digits or symbols/);
});

await test('Fact auditor changes are kept and reference-number flags are passed', async () => {
  const fixture = fake((stage) => {
    if (stage === 'writer') { const plan = written(); plan.scenes[0].fact = 'Water accounts for 99 percent of this fictional environmental process.'; return textAnswer(plan); }
    return undefined;
  });
  const result = await prepare(fixture.transport, { referenceLookup: async () => ({ title: 'Water', text: 'Water circulates through evaporation, condensation, rainfall and collection.' }) });
  const audit = fixture.requests.find((call) => call.stage === 'auditor')!;
  assert.match(JSON.stringify(audit.request.contents), /99/);
  assert.equal(result.scenes[0].fact, written().scenes[0].fact);
  assert.deepEqual(result.metadata.reference, { title: 'Water' });
});

await test('Unsupported reference numbers still present after review fail before TTS', async () => {
  const fixture = fake((stage) => {
    if (stage !== 'auditor') return undefined;
    return textAnswer({ scenes: written().scenes.map((scene) => ({ ...scene, verdict: 'correct', fact: 'Water accounts for 99 percent of this fictional environmental process.' })) });
  });
  await assert.rejects(prepare(fixture.transport, { referenceLookup: async () => ({ title: 'Water', text: 'No quantitative statistics are stated in this water reference.' }) }), /numbers not supported/);
  assert.equal(fixture.requests.filter((call) => call.stage === 'auditor').length, 2);
  assert.ok(!fixture.requests.some((call) => call.stage === 'tts'));
});

await test('Invalid overlays are repaired or dropped without altering audited facts', async () => {
  const fixture = fake((stage) => {
    if (stage === 'writer') { const plan = written(); plan.scenes[0].overlay = { kind: 'bars', values: [12, 24], unit: '' } as never; return textAnswer(plan); }
    if (stage === 'repair') return textAnswer({ scenes: [{ index: 1, fact: 'Water appears in quantities of 12 and 24 in this example.', overlay: { kind: 'bars', values: [12, 24], unit: '' } }] });
    return undefined;
  });
  const result = await prepare(fixture.transport);
  assert.deepEqual(result.scenes[0].overlay, { kind: 'none' });
  assert.equal(result.scenes[0].fact, written().scenes[0].fact);
  assert.ok(result.metadata.warnings.some((warning) => warning.includes('changed the audited fact')));
});

await test('An unavailable overlay repair cannot block an otherwise valid lesson', async () => {
  const fixture = fake((stage) => {
    if (stage === 'writer') { const plan = written(); plan.scenes[0].overlay = { kind: 'bars', values: [12, 24], unit: '' } as never; return textAnswer(plan); }
    if (stage === 'repair') throw Object.assign(new Error('service temporarily unavailable'), { status: 503 });
    return undefined;
  });
  const result = await prepare(fixture.transport);
  assert.deepEqual(result.scenes[0].overlay, { kind: 'none' });
  assert.ok(result.metadata.warnings.some((warning) => warning.includes('unavailable')));
});

await test('Arrows without a directional teaching fact are removed', async () => {
  const fixture = fake((stage) => {
    if (stage === 'writer') { const plan = written(); plan.scenes[0].overlay = { kind: 'arrow', direction: 'right' } as never; return textAnswer(plan); }
    if (stage === 'auditor') return textAnswer({ scenes: written().scenes.map((scene) => ({ ...scene, verdict: 'correct', fact: 'Water is a familiar liquid used throughout our daily lives.', narration: 'Water is a familiar liquid essential for life around the world.' })) });
    return undefined;
  });
  const result = await prepare(fixture.transport);
  assert.deepEqual(result.scenes[0].overlay, { kind: 'none' });
});

await test('Director rejects repeated images, irrelevant subjects and printed matter', async () => {
  for (const issue of ['repeat', 'subject', 'writing', 'beats']) {
    const fixture = fake((stage) => {
      if (stage !== 'director') return undefined;
      const plan = directed();
      if (issue === 'repeat') plan.scenes[1].visualDescription = plan.scenes[0].visualDescription;
      if (issue === 'subject') plan.scenes[0].subject = 'a copper locomotive';
      if (issue === 'writing') plan.scenes[0].visualDescription = 'A large blackboard displaying equations beside a clear vessel of blue water.';
      if (issue === 'beats') plan.scenes[0].motionDescription = 'The water gently swirls around the vessel and settles.';
      return textAnswer(plan);
    });
    await assert.rejects(prepare(fixture.transport), /valid answer/);
    assert.ok(!fixture.requests.some((call) => call.stage === 'tts'));
  }
});

for (const languageCode of ['hi-IN', 'kn-IN'] as const) {
  await test(`${languageCode}: translated script and captions survive through exact narration assembly`, async () => {
    const sentence = languageCode === 'hi-IN' ? 'पानी हमारे पर्यावरण में लगातार घूमता रहता है और जीवन के लिए आवश्यक है।' : 'ನೀರು ನಮ್ಮ ಪರಿಸರದಲ್ಲಿ ನಿರಂತರವಾಗಿ ಚಲಿಸುತ್ತದೆ ಮತ್ತು ಜೀವಿಗಳಿಗೆ ಬಹಳ ಮುಖ್ಯವಾಗಿದೆ.';
    const caption = languageCode === 'hi-IN' ? 'पानी का चक्र' : 'ನೀರಿನ ಚಕ್ರ';
    const fixture = fake((stage, request) => {
      if (stage !== 'translator') return undefined;
      const items = JSON.parse((request.contents[0].parts[0] as { text: string }).text) as { id: string; kind: string }[];
      return textAnswer({ translations: items.map((item) => ({ id: item.id, text: item.kind === 'narration' ? sentence : caption })) });
    });
    const result = await prepare(fixture.transport, { input: { ...input, languageCode } });
    const canonical = result.metadata.sourcePlan;
    assert.ok(canonical);
    assert.ok(!canonical.scenes[0].narration.includes(sentence));
    fixture.requests.length = 0;
    const reused = await prepare(fixture.transport, { input: { ...input, languageCode }, sourcePlan: canonical });
    assert.equal(reused.scenes[0].narration, sentence);
    assert.deepEqual(reused.metadata.sourcePlan, canonical);
    assert.ok(fixture.requests.every(call => ['translator', 'tts'].includes(call.stage)));

    assert.equal(result.title, caption);
    assert.equal(result.scenes[0].narration, sentence);
    assert.equal(result.scenes[7].caption, caption);
    assert.equal(wavDurationSeconds(result.narration.wav), 60);
    const speech = fixture.requests.find((call) => call.stage === 'tts')!;
    assert.match(JSON.stringify(speech.request.contents), languageCode === 'hi-IN' ? /पानी/ : /ನೀರು/);
  });
}

await test('Translator IDs and wrong-script text are rejected before spending on TTS', async () => {
  const fixture = fake((stage, request) => {
    if (stage !== 'translator') return undefined;
    const items = JSON.parse((request.contents[0].parts[0] as { text: string }).text) as { id: string }[];
    return textAnswer({ translations: items.map((item) => ({ id: `wrong-${item.id}`, text: 'Water is needed for every living organism in the world.' })) });
  });
  await assert.rejects(prepare(fixture.transport, { input: { ...input, languageCode: 'kn-IN' } }), /valid answer/);
  assert.ok(!fixture.requests.some((call) => call.stage === 'tts'));
});

await test('An overrun revises and revoices only its scene, preserving the other seven voices', async () => {
  const original = written().scenes[2].narration;
  const revised = 'Water falls as rain and returns to rivers.';
  const fixture = fake((stage, request) => {
    if (stage === 'tts' && JSON.stringify(request.contents).includes(original)) return voiceAnswer(12);
    if (stage === 'editor') return textAnswer({ scenes: [{ index: 3, narration: revised }] });
    return undefined;
  });
  const result = await prepare(fixture.transport);
  assert.equal(result.scenes[2].narration, revised);
  assert.equal(fixture.requests.filter((call) => call.stage === 'tts').length, 10); // 8 natural + 1 brisk + 1 revised
  assert.equal(fixture.requests.filter((call) => call.stage === 'editor').length, 1);
  assert.equal(wavDurationSeconds(result.narration.wav), 60);
});

await test('Repeated overruns stop after two narration editing rounds', async () => {
  let edited = 0;
  const fixture = fake((stage) => {
    if (stage === 'tts') return voiceAnswer(12);
    if (stage === 'editor') { edited += 1; return textAnswer({ scenes: written().scenes.map((scene) => ({ index: scene.index, narration: 'Water moves through our environment in a repeating natural cycle.' })) }); }
    return undefined;
  });
  await assert.rejects(prepare(fixture.transport), /narration does not fit/);
  assert.equal(edited, 2);
});

const job: PrepareJob = { id: '11111111-1111-4111-8111-111111111111', project_id: '22222222-2222-4222-8222-222222222222',
  owner_id: 'user_teacher', kind: 'prepare', status: 'processing', worker_id: 'test-worker', attempts: 1, max_attempts: 2 };
function fakeStore() {
  const state = {
    heartbeat: 'ok' as HeartbeatState, completed: [] as PreparedCloudLesson[], uploaded: [] as Buffer[],
    failures: [] as { code: string; message: string; costUsd: number }[], beats: [] as number[],
  };
  const store: CloudPreparationStore = {
    async claim() { return job; },
    async project() { return input; },
    async heartbeat(_job, progress) { state.beats.push(progress); return state.heartbeat; },
    async upload(_job, wav) { state.uploaded.push(wav); return 'https://storage.example/lesson.wav'; },
    async complete(_job, lesson, url) { assert.equal(url, 'https://storage.example/lesson.wav'); state.completed.push(lesson); return true; },
    async fail(_job, code, message, costUsd) { state.failures.push({ code, message, costUsd }); return true; },
  };
  return { state, store };
}
const run = (store: CloudPreparationStore, transport: GeminiTransport, extra: Partial<Parameters<typeof runCloudPreparationJob>[0]> = {}) => runCloudPreparationJob({
  store, transport, job, referenceLookup: noReference, ...NO_WAIT, ...extra,
});

await test('Worker completes the claimed job with uploaded WAV, costs and timing metadata', async () => {
  const db = fakeStore();
  const result = await run(db.store, fake().transport);
  assert.equal(result.status, 'completed');
  assert.equal(db.state.completed.length, 1);
  assert.equal(db.state.uploaded.length, 1);
  assert.equal(wavDurationSeconds(db.state.uploaded[0]), 60);
  assert.equal(db.state.failures.length, 0);
  assert.equal(db.state.completed[0].metadata.narration.scenes.length, 8);
  assert.equal(db.state.beats.at(-1), 98);
});

await test('Cancellation before preparation stops all model calls and queues no images', async () => {
  const db = fakeStore(); db.state.heartbeat = 'cancel';
  const fixture = fake();
  const result = await run(db.store, fixture.transport);
  assert.equal(result.status, 'cancelled');
  assert.equal(fixture.requests.length, 0);
  assert.equal(db.state.completed.length, 0);
  assert.equal(db.state.uploaded.length, 0);
  assert.equal(db.state.failures[0].code, 'preparation_cancel');
});

await test('Lost ownership never writes completion or failure into a replacement worker job', async () => {
  const db = fakeStore();
  const fixture = fake((stage) => { if (stage === 'writer') db.state.heartbeat = 'lost'; return undefined; });
  const result = await run(db.store, fixture.transport);
  assert.equal(result.status, 'lost');
  assert.equal(fixture.requests.length, 1);
  assert.equal(db.state.failures.length, 0);
  assert.equal(db.state.completed.length, 0);
});

await test('Cancellation while uploading prevents completion and still reports known cost', async () => {
  const db = fakeStore();
  db.store.upload = async (_job, wav) => { db.state.uploaded.push(wav); db.state.heartbeat = 'cancel'; return 'https://storage.example/lesson.wav'; };
  const result = await run(db.store, fake().transport);
  assert.equal(result.status, 'cancelled');
  assert.equal(db.state.completed.length, 0);
  assert.ok(db.state.failures[0].costUsd > 0);
});

await test('Heartbeat keeps running during a long model call; lost leases stop further spending', async () => {
  const db = fakeStore();
  const fixture = fake(async (stage) => {
    if (stage === 'writer') {
      await new Promise((resolve) => setTimeout(resolve, 35));
      db.state.heartbeat = 'lost';
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return undefined;
  });
  const result = await run(db.store, fixture.transport, { heartbeatMs: 5 });
  assert.equal(result.status, 'lost');
  assert.ok(db.state.beats.length > 5);
  assert.equal(fixture.requests.length, 1);
  assert.equal(db.state.completed.length, 0);
});

await test('Heartbeat transport failure conservatively abandons the lease', async () => {
  const db = fakeStore(); db.store.heartbeat = async () => { throw new Error('database offline'); };
  const fixture = fake();
  const result = await run(db.store, fixture.transport);
  assert.equal(result.status, 'lost');
  assert.equal(fixture.requests.length, 0);
  assert.equal(db.state.failures.length, 0);
});

await test('Provider failures record a teacher-readable error without leaking provider body', async () => {
  const db = fakeStore();
  const fixture = fake((stage) => { if (stage === 'auditor') throw Object.assign(new Error('private-key-token must never appear in a teacher message'), { status: 403 }); return undefined; });
  const result = await run(db.store, fixture.transport);
  assert.equal(result.status, 'failed');
  assert.equal(db.state.failures[0].code, 'gemini_rejected');
  assert.ok(!db.state.failures[0].message.includes('private-key-token'));
  assert.ok(db.state.failures[0].costUsd > 0);
  assert.equal(db.state.completed.length, 0);
});

await test('A failed voice drains in-flight siblings before recording costs and starts no further scenes', async () => {
  const db = fakeStore();
  let returned = 0;
  const fixture = fake(async (stage, _request, count) => {
    if (stage !== 'tts') return undefined;
    if (count === 1) throw Object.assign(new Error('voice rejected'), { status: 403 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    returned += 1;
    return voiceAnswer(12); // Would normally trigger a second, brisk request.
  });
  const originalFail = db.store.fail;
  db.store.fail = async (...args) => {
    assert.equal(returned, 3, 'All three sibling paid responses must be drained first');
    return originalFail(...args);
  };
  const result = await run(db.store, fixture.transport);
  assert.equal(result.status, 'failed');
  assert.equal(fixture.requests.filter((call) => call.stage === 'tts').length, 4);
  assert.equal(db.state.completed.length, 0);
  assert.ok(db.state.failures[0].costUsd > 0);
});

await test('Shutdown leaves the lease for recovery and starts no model requests', async () => {
  const db = fakeStore(); const controller = new AbortController(); controller.abort();
  const fixture = fake();
  const result = await run(db.store, fixture.transport, { signal: controller.signal });
  assert.equal(result.status, 'shutdown');
  assert.equal(fixture.requests.length, 0);
  assert.equal(db.state.failures.length, 0);
});

await test('False completion is treated as lost ownership, not requeued or duplicated', async () => {
  const db = fakeStore(); db.store.complete = async () => false;
  const result = await run(db.store, fake().transport);
  assert.equal(result.status, 'lost');
  assert.equal(db.state.failures.length, 0);
});

await test('Unknown exceptions are sanitized before recording them', async () => {
  assert.ok(!preparationFailure(new Error('secret-value')).message.includes('secret-value'));
});

console.log(`\n${passed} cloud preparation tests passed; no live APIs or database writes.`);
