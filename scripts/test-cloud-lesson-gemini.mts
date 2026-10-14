/**
 * Offline tests for the cloud lesson engine's Gemini layer — no network, no cost.
 *
 *   npm run test:cloud-gemini
 *
 * A fake transport stands in for Gemini, so every branch is exercised: the
 * first-answer pass, a validation correction, invalid JSON, running out of
 * attempts, transient and permanent HTTP errors, the schema fallback, blocked
 * prompts, speech decoding, narration fitting and the keyframe gate.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  concat, durationSeconds, fromInt16, padTo, type Pcm, speedUp, toWav, trimSilence, wavDurationSeconds,
} from '../src/lib/cloud-lesson/audio.ts';
import {
  decodeSpeechPayload, GeminiCallError, isHardQuota, retryAfterMs, type GeminiRequest, type GeminiResponse, type GeminiTransport,
  generateSpeech, generateStructured,
} from '../src/lib/cloud-lesson/gemini.ts';
import { assembleNarration, MAX_SPEEDUP, SLOT_GUARD_SECONDS, voiceLesson, voiceScene } from '../src/lib/cloud-lesson/narration.ts';
import { CostMeter, priceGeminiUsage, rateFor } from '../src/lib/cloud-lesson/pricing.ts';
import { loadCloudLessonSkill } from '../src/lib/cloud-lesson/skills.ts';
import { checkKeyframe, decideKeyframe } from '../src/lib/cloud-lesson/vision.ts';

let passed = 0;
async function test(name: string, body: () => Promise<void> | void) {
  await body();
  passed += 1;
  console.log(`ok  ${name}`);
}

const RATE = 24_000;
const NO_WAIT = { retryDelaysMs: [0, 0], maxRetryWaitMs: 0 };

function tone(seconds: number, frequency = 220, amplitude = 0.3, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
}

function withSilence(speech: Float32Array, lead = 0.3, tail = 0.4, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round((lead + tail) * rate) + speech.length);
  out.set(speech, Math.round(lead * rate));
  return out;
}

/** Dominant frequency from zero crossings — enough to tell a pitch shift apart. */
function frequencyOf(audio: Pcm): number {
  const middle = audio.samples.subarray(Math.floor(audio.samples.length * 0.2), Math.floor(audio.samples.length * 0.8));
  let crossings = 0;
  for (let i = 1; i < middle.length; i += 1) if ((middle[i - 1] < 0) !== (middle[i] < 0)) crossings += 1;
  return crossings / 2 / (middle.length / audio.sampleRate);
}

function pcmBase64(samples: Float32Array): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(Math.round(value * 32767), i * 2));
  return buffer.toString('base64');
}

/** A fake Vertex: answers in order, records every request. */
function fake(answers: (GeminiResponse | Error | ((request: GeminiRequest) => GeminiResponse))[]) {
  const requests: GeminiRequest[] = [];
  const transport: GeminiTransport = {
    async generateContent(request) {
      requests.push(structuredClone(request));
      const next = answers.shift();
      if (!next) throw new Error('fake transport ran out of answers');
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(request) : next;
    },
  };
  return { transport, requests };
}

const textAnswer = (value: unknown, usage = { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 200 }) => ({
  candidates: [{ content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] }, finishReason: 'STOP' }],
  usageMetadata: usage,
});

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

// ── Pricing ──────────────────────────────────────────────────────────────────

await test('pricing: thinking bills as output; unknown models are null, not free', () => {
  const priced = priceGeminiUsage('gemini-2.5-flash', { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 200 });
  assert.equal(priced.costUsd, (1000 * 0.3 + 700 * 2.5) / 1e6);
  assert.equal(priceGeminiUsage('gemini-2.5-flash-001', { promptTokenCount: 1_000_000 }).costUsd, 0.3);
  assert.equal(priceGeminiUsage('some-new-model', { promptTokenCount: 10 }).costUsd, null);
  const audio = priceGeminiUsage('gemini-2.5-flash-tts', {
    promptTokenCount: 40, candidatesTokenCount: 200, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 200 }],
  });
  assert.equal(audio.costUsd, (40 * 0.5 + 200 * 10) / 1e6);
});

await test('pricing: 3.x promotional rates switch on 2027-01-01 by the call date', () => {
  const usage = { promptTokenCount: 1000, candidatesTokenCount: 1500, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 1500 }] };
  assert.equal(priceGeminiUsage('gemini-3.8-flash-tts', usage, new Date('2026-12-31T23:00:00Z')).costUsd, (1000 * 0.5 + 1500 * 9) / 1e6);
  assert.equal(priceGeminiUsage('gemini-3.8-flash-tts', usage, new Date('2027-01-01T00:00:00Z')).costUsd, (1000 * 1 + 1500 * 18) / 1e6);
  assert.equal(rateFor('gemini-3.6-flash', new Date('2027-03-01'))?.output, 7.5);
  assert.equal(rateFor('gemini-3.5-flash-lite', new Date('2027-03-01'))?.output, 2.5);
  // A 1K keyframe is ~1120 image tokens: $0.0336.
  const image = priceGeminiUsage('gemini-nano-banana-2.1', {
    candidatesTokenCount: 1120, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
  });
  assert.equal(image.costUsd, 0.0336);
});

// ── Audio ────────────────────────────────────────────────────────────────────

await test('audio: WAV round trip keeps length and rate', () => {
  const audio = { samples: tone(1.5), sampleRate: RATE };
  const wav = toWav(audio);
  assert.equal(wavDurationSeconds(wav), 1.5);
  const decoded = decodeSpeechPayload('audio/wav', wav.toString('base64'));
  assert.equal(decoded.sampleRate, RATE);
  assert.equal(decoded.pcm.length, audio.samples.length);
});

await test('audio: raw L16 from Gemini decodes at the stated rate', () => {
  const decoded = decodeSpeechPayload('audio/L16;codec=pcm;rate=24000', pcmBase64(tone(0.5)));
  assert.equal(decoded.sampleRate, 24_000);
  assert.equal(decoded.pcm.length, 12_000);
});

await test('audio: silence is trimmed to the speech plus a little air', () => {
  const trimmed = trimSilence({ samples: withSilence(tone(2), 0.5, 0.5), sampleRate: RATE });
  assert.ok(Math.abs(durationSeconds(trimmed) - 2.18) < 0.03, `got ${durationSeconds(trimmed)}`);
});

await test('audio: speed-up shortens by the ratio and keeps the pitch', () => {
  const original = { samples: tone(3, 220), sampleRate: RATE };
  const faster = speedUp(original, 1.2);
  assert.ok(Math.abs(durationSeconds(faster) - 2.5) < 0.01, `duration ${durationSeconds(faster)}`);
  const pitch = frequencyOf(faster);
  assert.ok(Math.abs(pitch - 220) / 220 < 0.03, `pitch drifted to ${pitch.toFixed(1)} Hz`);
  // Naive resampling would have raised it to 264 Hz.
});

await test('audio: padding is exact and refuses audio longer than its slot', () => {
  const padded = padTo({ samples: tone(3), sampleRate: RATE }, 7.5);
  assert.equal(padded.samples.length, 7.5 * RATE);
  assert.throws(() => padTo({ samples: tone(8), sampleRate: RATE }, 7.5), /longer than/);
  const lesson = concat(Array.from({ length: 8 }, () => padded));
  assert.equal(durationSeconds(lesson), 60);
});

// ── Structured output ───────────────────────────────────────────────────────

const skill = await loadCloudLessonSkill('cloud-lesson-math-repair');
const Schema = z.object({ scenes: z.array(z.object({ index: z.number().int(), fact: z.string().min(10) })).min(1) });
const valid = { scenes: [{ index: 2, fact: 'Two plus two makes four.' }] };
const base = { skill, values: { topic: 'Addition' }, userPrompt: 'Fix scene 2.', schema: Schema, ...NO_WAIT };

await test('structured: a valid first answer passes, sends the schema, and is priced', async () => {
  const meter = new CostMeter();
  const { transport, requests } = fake([textAnswer(valid)]);
  const result = await generateStructured({ ...base, transport, meter });
  assert.deepEqual(result, { data: valid, attempts: 1 });
  assert.equal(requests[0].model, 'gemini-3.5-flash-lite');
  assert.equal(requests[0].config.responseMimeType, 'application/json');
  assert.ok(requests[0].config.responseJsonSchema, 'schema sent');
  assert.deepEqual(requests[0].config.thinkingConfig, { thinkingLevel: 'LOW' });
  assert.ok(!('temperature' in requests[0].config), 'Gemini 3.x keeps its default temperature');
  assert.match(String(requests[0].config.systemInstruction), /lesson on\s+"Addition"/);
  assert.equal(meter.records.length, 1);
  assert.equal(meter.totalUsd, Math.round(((1000 * 0.3 + 700 * 2.5) / 1e6) * 1e4) / 1e4);
});

await test('structured: a refused thinking setting is dropped once, not retried forever', async () => {
  const { transport, requests } = fake([
    () => { throw httpError(400, 'Thinking level is not supported for this model.'); },
    textAnswer(valid),
  ]);
  const result = await generateStructured({ ...base, transport });
  assert.equal(result.attempts, 1);
  assert.equal(requests.length, 2);
  assert.ok(!('thinkingConfig' in requests[1].config));
});

await test('structured: a 2.5 override with thinkingBudget sends a budget, not a level', async () => {
  const { transport, requests } = fake([textAnswer(valid)]);
  await generateStructured({ ...base, skill: { ...skill, modelId: 'gemini-2.5-flash', thinkingLevel: null, thinkingBudget: 512 }, transport });
  assert.deepEqual(requests[0].config.thinkingConfig, { thinkingBudget: 512 });
});

await test('structured: a failed validation is sent back as a correction in the same conversation', async () => {
  const { transport, requests } = fake([textAnswer({ scenes: [{ index: 2, fact: 'short' }] }), textAnswer(valid)]);
  const result = await generateStructured({ ...base, transport });
  assert.equal(result.attempts, 2);
  const second = requests[1].contents;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'model');
  assert.match(JSON.stringify(second[2]), /scenes\.0\.fact/);
});

await test('structured: fenced or chatty JSON is extracted; broken JSON gets a retry', async () => {
  const { transport } = fake([textAnswer('Here you go: {"scenes": [ '), textAnswer(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)]);
  assert.equal((await generateStructured({ ...base, transport })).attempts, 2);
});

await test('structured: running out of attempts fails with the last problem, not a bad answer', async () => {
  const bad = textAnswer({ scenes: [] });
  const { transport } = fake([bad, bad]);
  await assert.rejects(generateStructured({ ...base, transport }), (error: unknown) =>
    error instanceof GeminiCallError && error.code === 'gemini_invalid_output' && /scenes/.test(error.message));
});

await test('structured: a transient 503 is retried; a 403 is not', async () => {
  const flaky = fake([httpError(503, 'overloaded'), textAnswer(valid)]);
  assert.equal((await generateStructured({ ...base, transport: flaky.transport })).attempts, 1);
  assert.equal(flaky.requests.length, 2);
  const denied = fake([httpError(403, 'permission denied'), textAnswer(valid)]);
  await assert.rejects(generateStructured({ ...base, transport: denied.transport }), (error: unknown) =>
    error instanceof GeminiCallError && error.code === 'gemini_rejected' && error.status === 403);
  assert.equal(denied.requests.length, 1);
});

await test('structured: a generic schema rejection falls back without losing validation', async () => {
  const { transport, requests } = fake([
    httpError(400, 'Request contains an invalid argument.'),
    textAnswer({}),
    textAnswer(valid),
  ]);
  const result = await generateStructured({ ...base, transport });
  assert.deepEqual(result.data, valid);
  assert.equal(requests.length, 3);
  assert.ok(requests[0].config.responseJsonSchema);
  assert.ok(!('responseJsonSchema' in requests[1].config));
  assert.ok(!('responseJsonSchema' in requests[2].config));
  assert.deepEqual(requests[1].config.thinkingConfig, requests[0].config.thinkingConfig);
});

await test('structured: repeated generic rejection stops after one schema fallback', async () => {
  const { transport, requests } = fake([
    httpError(400, 'Request contains an invalid argument.'),
    httpError(400, 'Request contains an invalid argument.'),
  ]);
  await assert.rejects(generateStructured({ ...base, transport }),
    (error: unknown) => error instanceof GeminiCallError && error.status === 400);
  assert.equal(requests.length, 2);
});

await test('structured: a schema Vertex refuses falls back to plain JSON mode once', async () => {
  const { transport, requests } = fake([httpError(400, 'Invalid JSON schema: unsupported keyword'), textAnswer(valid)]);
  const result = await generateStructured({ ...base, transport });
  assert.equal(result.attempts, 1);
  assert.ok(requests[0].config.responseJsonSchema);
  assert.equal(requests[1].config.responseJsonSchema, undefined);
});

await test('quota: a 429 waits as long as it asks; free-tier and daily quotas are not retried', async () => {
  const rpm = httpError(429, '{"error":{"code":429,"message":"Quota exceeded for metric: x_requests_per_minute. Please retry in 21.347s.","details":[{"retryDelay":"21s"}]}}');
  assert.equal(retryAfterMs(rpm), 21_000);
  assert.equal(retryAfterMs(httpError(429, 'Please retry in 2.5s.')), 2_500);
  assert.equal(retryAfterMs(httpError(429, 'busy')), null);
  assert.equal(isHardQuota(rpm), false);
  const free = httpError(429, 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 3');
  assert.equal(isHardQuota(free), true);
  assert.equal(isHardQuota(httpError(429, 'GenerateRequestsPerDayPerProjectPerModel')), true);

  const { transport, requests } = fake([() => { throw free; }, textAnswer(valid)]);
  await assert.rejects(
    generateStructured({ ...base, transport }),
    (error: unknown) => error instanceof GeminiCallError && error.code === 'gemini_quota' && /FREE tier/.test(error.message),
  );
  assert.equal(requests.length, 1, 'a free-tier 429 is not retried');

  const retried = fake([() => { throw rpm; }, textAnswer(valid)]);
  assert.equal((await generateStructured({ ...base, transport: retried.transport })).attempts, 1);
  assert.equal(retried.requests.length, 2, 'a per-minute 429 is retried');
});

await test('structured: a blocked prompt fails clearly', async () => {
  const { transport } = fake([{ promptFeedback: { blockReason: 'SAFETY' } }]);
  await assert.rejects(generateStructured({ ...base, transport }), (error: unknown) =>
    error instanceof GeminiCallError && error.code === 'gemini_blocked');
});

// ── Speech and narration ────────────────────────────────────────────────────

/** Fake TTS: speech length per call comes from the list, wrapped in silence. */
function fakeSpeech(seconds: number[]) {
  return fake(seconds.map((length) => () => ({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmBase64(withSilence(tone(length, 180))) } }] } }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: Math.round(length * 25), candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: Math.round(length * 25) }] },
  })));
}

const scene = { index: 1, sentence: 'Leaves use sunlight to make food.', languageCode: 'kn-IN' as const, slotSeconds: 7.5, ...NO_WAIT };

await test('speech: the text is the narration only; pace and accent travel as a style', async () => {
  const { transport, requests } = fakeSpeech([3]);
  const speech = await generateSpeech({ transport, text: 'Namaste', languageCode: 'en-IN', pace: 'brisk', voice: 'Kore', model: 'gemini-3.8-flash-tts', ...NO_WAIT });
  assert.equal(speech.sampleRate, 24_000);
  const part = requests[0].contents[0].parts[0] as { text: string; speechMetadata?: { style?: string } };
  assert.equal(part.text, 'Namaste', 'a 3.x speech model reads the text verbatim, so nothing else may be in it');
  assert.match(part.speechMetadata?.style ?? '', /brisk.*Indian English accent/);
  assert.deepEqual(requests[0].config.responseModalities, ['AUDIO']);
  assert.match(JSON.stringify(requests[0].config.speechConfig), /Kore/);
});

await test('speech: a model that refuses speechMetadata is asked again with plain text', async () => {
  const { transport: inner, requests } = fakeSpeech([3]);
  let first = true;
  const transport: GeminiTransport = {
    generateContent: (request) => {
      if (first) {
        first = false;
        requests.push(request);
        return Promise.reject(httpError(400, 'Invalid JSON payload received. Unknown name "speech_metadata"'));
      }
      return inner.generateContent(request);
    },
  };
  await generateSpeech({ transport, text: 'Namaste', languageCode: 'hi-IN', pace: 'natural', model: 'gemini-2.5-flash-tts', ...NO_WAIT });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].contents[0].parts[0], { text: 'Namaste' });
});

await test('narration: a sentence that fits is used as spoken', async () => {
  const { transport, requests } = fakeSpeech([5]);
  const voice = await voiceScene({ ...scene, transport });
  assert.equal(requests.length, 1);
  assert.equal(voice.pace, 'natural');
  assert.equal(voice.speedUp, 1);
  assert.ok(Math.abs(voice.finalSeconds - 5.18) < 0.03);
});

await test('narration: a slightly long sentence gets a brisk take, then a gentle speed-up', async () => {
  const { transport, requests } = fakeSpeech([8, 7.6]);
  const voice = await voiceScene({ ...scene, transport });
  assert.equal(requests.length, 2);
  assert.equal(voice.pace, 'brisk');
  assert.ok(voice.speedUp > 1 && voice.speedUp <= MAX_SPEEDUP, `speed-up ${voice.speedUp}`);
  assert.ok(voice.finalSeconds <= scene.slotSeconds - SLOT_GUARD_SECONDS + 1e-6);
});

await test('narration: a sentence far too long is reported as an overrun, not squeezed', async () => {
  const { transport } = fakeSpeech([11, 10.5]);
  const voice = await voiceScene({ ...scene, transport });
  assert.equal(voice.overran, true);
  assert.equal(voice.speech, null);
});

await test('narration: 8 scenes assemble to exactly 60 s with each sentence on its scene boundary', async () => {
  const lengths = [4, 5, 6, 3.5, 5.5, 4.5, 6.5, 5];
  const meter = new CostMeter();
  const { transport } = fakeSpeech(lengths);
  const voices = await voiceLesson({
    sentences: lengths.map((_, i) => `Sentence ${i + 1}.`), languageCode: 'hi-IN', slotSeconds: 7.5, transport, meter, ...NO_WAIT,
  });
  const narration = assembleNarration(voices, 7.5);
  assert.equal(narration.durationSeconds, 60);
  assert.equal(wavDurationSeconds(narration.wav), 60);
  const track = fromInt16(new Int16Array(narration.wav.buffer.slice(narration.wav.byteOffset + 44)), RATE);
  for (let k = 0; k < 8; k += 1) {
    const start = Math.round(k * 7.5 * RATE);
    const head = track.samples.subarray(start, start + Math.round(0.2 * RATE));
    assert.ok(head.some((value) => Math.abs(value) > 0.05), `scene ${k + 1} does not start on its boundary`);
    const guard = track.samples.subarray(start + Math.round((7.5 - SLOT_GUARD_SECONDS) * RATE), start + 7.5 * RATE);
    assert.ok(guard.every((value) => value === 0), `scene ${k + 1} runs into the next`);
  }
  assert.equal(meter.records.length, 8);
  assert.ok(meter.totalUsd > 0);
});

await test('narration: assembly refuses while any scene overran', async () => {
  const { transport } = fakeSpeech([11, 10.5]);
  const voice = await voiceScene({ ...scene, transport });
  assert.throws(() => assembleNarration([voice], 7.5), /does not fit/);
});

// ── Keyframe gate ───────────────────────────────────────────────────────────

await test('keyframe: problems regenerate; on the last attempt only off-subject is tolerated', () => {
  const good = { showsSubject: true, singlePhoto: true, hasWriting: false, unsafe: false, reason: 'Fine.' };
  assert.equal(decideKeyframe(good, false).accept, true);
  const offSubject = { ...good, showsSubject: false, reason: 'No leaf.' };
  assert.equal(decideKeyframe(offSubject, false).accept, false);
  assert.equal(decideKeyframe(offSubject, true).acceptedOnFinalAttempt, true);
  assert.equal(decideKeyframe({ ...good, hasWriting: true }, true).accept, false);
  assert.equal(decideKeyframe({ ...good, unsafe: true }, true).accept, false);
});

await test('keyframe: the checker sees the image before the description', async () => {
  const { transport, requests } = fake([textAnswer({ showsSubject: true, singlePhoto: true, hasWriting: true, unsafe: false, reason: 'A label is visible.' })]);
  const decision = await checkKeyframe({
    transport, image: { mimeType: 'image/png', data: Buffer.from('png') }, description: 'A green leaf.', finalAttempt: false, ...NO_WAIT,
  });
  assert.equal(decision.accept, false);
  assert.deepEqual(decision.problems, ['writing visible']);
  const parts = requests[0].contents[0].parts;
  assert.ok('inlineData' in parts[0] && 'text' in parts[1]);
  assert.equal(requests[0].model, 'gemini-3.5-flash-lite');
  assert.deepEqual(requests[0].config.thinkingConfig, { thinkingLevel: 'MINIMAL' });
});

console.log(`cloud lesson Gemini layer: ${passed} tests passed`);
