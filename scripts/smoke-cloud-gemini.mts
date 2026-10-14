/**
 * LIVE smoke test for the cloud lesson engine's Gemini calls. Costs about
 * two US cents (about nine with --image: two keyframes at ~$0.034 each).
 *
 *   npm run smoke:cloud-gemini            text + speech + vision
 *   npm run smoke:cloud-gemini -- --image also one keyframe image
 *
 * Proves, against your real Gemini key (AI Studio or Vertex):
 *   1. structured text works (the translator skill, English → Kannada and Hindi)
 *   2. which speech model your key accepts, and what the voice sounds like
 *   3. narration fitting on real speech
 *   4. the keyframe checker on a known picture
 *   5. (--image) the keyframe image model, then a second keyframe in the
 *      first one's style — the path scenes 2-8 take
 *
 * Writes what it hears and sees to generated/cloud-smoke/ (gitignored).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { z } from 'zod';

import { durationSeconds, fromInt16, toWav, trimSilence } from '../src/lib/cloud-lesson/audio.ts';
import { GeminiCallError, generateImage, generateSpeech, generateStructured } from '../src/lib/cloud-lesson/gemini.ts';
import { assembleNarration, voiceLesson } from '../src/lib/cloud-lesson/narration.ts';
import { CostMeter } from '../src/lib/cloud-lesson/pricing.ts';
import { loadAllCloudLessonSkills, loadCloudLessonSkill } from '../src/lib/cloud-lesson/skills.ts';
import { checkKeyframe } from '../src/lib/cloud-lesson/vision.ts';
import { serverEnv } from '../src/lib/env.ts';

const out = path.join(process.cwd(), 'generated', 'cloud-smoke');
await mkdir(out, { recursive: true });
const meter = new CostMeter();
const withImage = process.argv.includes('--image');
const step = (title: string) => console.log(`\n── ${title}`);
/**
 * Stops the run with exit code 1 WITHOUT process.exit(): on Windows, exiting
 * while fetch sockets are still closing trips a libuv assertion
 * ("!(handle->flags & UV_HANDLE_CLOSING)"). Throwing lets the event loop drain.
 */
class SmokeStop extends Error {}
process.on('uncaughtException', (error) => {
  process.exitCode = 1;
  if (!(error instanceof SmokeStop)) console.error(error);
});
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(message)) {
    const project = message.match(/project[= ](\d{6,})/)?.[1];
    console.error([
      '',
      'Your key is fine, but the Vertex AI API is switched off in its Google Cloud project.',
      '  (Or use an AI Studio key instead: set GEMINI_API_KEY=AIza… in .env.)',
      `  1. Open https://console.cloud.google.com/apis/library/aiplatform.googleapis.com${project ? `?project=${project}` : ''}`,
      '     (signed in as the Google account that created the key) and click Enable.',
      '  2. If it asks for billing, link a billing account to that project (Billing → Link a billing account).',
      '  3. Wait 2-5 minutes, then run this smoke test again.',
    ].join('\n'));
  }
  if (/free_tier|FREE tier/i.test(message)) {
    console.error([
      '',
      'Your key works, but Google is treating it as a FREE-tier key: billing is not active on the',
      'Google Cloud project the key belongs to (free tier allows only a few speech calls per minute).',
      'Credit loaded on a different project or account does not count.',
      '  1. Open https://aistudio.google.com/apikey and note the PROJECT shown next to this key.',
      '  2. In AI Studio → Billing (or console.cloud.google.com/billing), link that project to the',
      '     billing account that holds your credit. The key\'s tier should change from "Free" to "Tier 1".',
      '  3. Check the limits it now has at https://ai.dev/rate-limit, then run this smoke test again.',
    ].join('\n'));
  }
  if (/no longer available|is not found|NOT_FOUND/i.test(message)) {
    console.error([
      '',
      'Google has retired or renamed a model this engine names. Override it in .env without editing code:',
      '  CLOUD_LESSON_MODEL_<SKILL>=gemini/<model>   e.g. CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR=gemini/gemini-3.8-flash',
      '  CLOUD_LESSON_TTS_MODEL=<model>   CLOUD_LESSON_IMAGE_MODEL=<model>',
      'Current names: https://ai.google.dev/gemini-api/docs/models',
    ].join('\n'));
  }
  throw new SmokeStop(message);
};

step('configuration');
const backend = serverEnv.cloudLessonGeminiBackend;
const key = serverEnv.cloudLessonGeminiApiKey;
const keyName = backend === 'aistudio' ? 'GEMINI_API_KEY' : 'GOOGLE_VERTEX_API_KEY';
console.log(`backend: ${backend === 'aistudio' ? 'Google AI Studio (Gemini API)' : 'Vertex AI (express mode)'}  — from ${keyName}`);
// The two commonest paste mistakes, caught before any call is made.
if (/^gen-lang-client-\d+$/.test(key)) {
  fail([
    `${keyName} holds your AI Studio PROJECT ID (gen-lang-client-…), not an API key.`,
    '  Open https://aistudio.google.com/apikey, click "Create API key" (or copy an existing one —',
    '  it starts with AIza), and put that in .env as GEMINI_API_KEY=AIza…',
  ].join('\n'));
}
if (backend === 'aistudio' && !/^(AIza|AQ\.)/.test(key)) {
  console.log(`⚠ ${keyName} does not look like an AI Studio key (AIza… or AQ.…). Continuing anyway.`);
}
if (backend === 'vertex' && !key.startsWith('AQ.')) {
  console.log(`⚠ ${keyName} does not start with AQ. — Vertex express keys normally do. Continuing anyway.`);
}
console.log(`key: ${key.slice(0, 4)}… (${key.length} chars)`);
console.log(`speech model: ${serverEnv.cloudLessonTtsModel}   voice: ${serverEnv.cloudLessonTtsVoice}   image model: ${serverEnv.cloudLessonImageModel}`);
const skills = await loadAllCloudLessonSkills();
console.log(`skills: ${skills.map((skill) => `${skill.name}→${skill.modelId} (${skill.thinkingLevel ?? skill.thinkingBudget})`).join(', ')}`);

// 1. Structured text through a real skill.
step('1. structured text (translator skill)');
const translator = await loadCloudLessonSkill('cloud-lesson-translator');
const TranslationSchema = z.object({
  translations: z.array(z.object({ id: z.string(), text: z.string().min(1) })).length(2),
});
const english = [
  { id: 'n1', kind: 'narration', text: 'Leaves use sunlight, water and air to make their own food.' },
  { id: 'c1', kind: 'caption', text: 'Plants make food' },
];
const translated: Record<string, string> = {};
for (const [code, languageName] of [['kn-IN', 'Kannada'], ['hi-IN', 'Hindi']] as const) {
  try {
    const { data, attempts } = await generateStructured({
      skill: translator,
      values: { classLevel: 7, subject: 'Science', languageName, sceneSeconds: 7.5 },
      userPrompt: `Translate these items into ${languageName}:\n${JSON.stringify(english)}`,
      schema: TranslationSchema,
      meter,
    });
    translated[code] = data.translations[0].text;
    console.log(`${languageName} (${attempts} attempt${attempts > 1 ? 's' : ''}): ${data.translations.map((item) => item.text).join('  |  ')}`);
  } catch (error) {
    fail(`text call failed: ${error instanceof Error ? error.message : error}`);
  }
}

// 2. Which speech model does the key accept?
step('2. speech model');
const candidates = [...new Set([serverEnv.cloudLessonTtsModel, 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])];
let ttsModel: string | null = null;
for (const model of candidates) {
  try {
    const speech = await generateSpeech({ text: english[0].text, languageCode: 'en-IN', pace: 'natural', model, meter });
    const audio = trimSilence(fromInt16(speech.pcm, speech.sampleRate));
    await writeFile(path.join(out, 'voice-en.wav'), toWav(audio));
    console.log(`✓ ${model} works — ${durationSeconds(audio).toFixed(2)} s of English at ${speech.sampleRate} Hz → generated/cloud-smoke/voice-en.wav`);
    ttsModel = model;
    break;
  } catch (error) {
    const reason = error instanceof GeminiCallError && error.status ? `HTTP ${error.status}` : (error instanceof Error ? error.message.slice(0, 160) : String(error));
    console.log(`✗ ${model}: ${reason}`);
  }
}
if (!ttsModel) fail('no speech model name worked — check the key and that billing is enabled on its project');
if (ttsModel !== serverEnv.cloudLessonTtsModel) {
  console.log(`→ set CLOUD_LESSON_TTS_MODEL=${ttsModel} in .env`);
}

// 3. Narration fitting on real Kannada and Hindi speech.
step('3. narration fitting (Kannada + Hindi, 2 slots of 7.5 s)');
for (const [code, label] of [['kn-IN', 'kn'], ['hi-IN', 'hi']] as const) {
  const voices = await voiceLesson({ sentences: [translated[code], translated[code]], languageCode: code, slotSeconds: 7.5, model: ttsModel!, meter })
    .catch((error: unknown) => fail(`speech failed: ${error instanceof Error ? error.message : error}`));
  for (const voice of voices) {
    console.log(`${label} scene ${voice.index}: natural ${voice.naturalSeconds}s → plays ${voice.finalSeconds}s (${voice.pace}${voice.speedUp > 1 ? `, sped up ×${voice.speedUp}` : ''})${voice.overran ? '  OVERRAN' : ''}`);
  }
  if (voices.every((voice) => !voice.overran)) {
    const narration = assembleNarration(voices, 7.5);
    await writeFile(path.join(out, `narration-${label}.wav`), narration.wav);
    console.log(`→ ${narration.durationSeconds}s track → generated/cloud-smoke/narration-${label}.wav  (listen to it)`);
  }
}

// 4. The keyframe checker on a picture whose answer we know.
step('4. keyframe checker');
const ball = await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#8a8a86' } })
  .composite([{ input: Buffer.from('<svg width="1024" height="576"><circle cx="512" cy="300" r="150" fill="#c0392b"/></svg>') }])
  .png().toBuffer();
const labelled = await sharp(ball)
  .composite([{ input: Buffer.from('<svg width="1024" height="576"><text x="380" y="120" font-size="72" font-family="sans-serif" fill="#fff">BALL</text></svg>') }])
  .png().toBuffer();
await writeFile(path.join(out, 'check-clean.png'), ball);
await writeFile(path.join(out, 'check-labelled.png'), labelled);
const clean = await checkKeyframe({ image: { mimeType: 'image/png', data: ball }, description: 'A red ball resting on a plain grey surface.', finalAttempt: false, meter });
const lettered = await checkKeyframe({ image: { mimeType: 'image/png', data: labelled }, description: 'A red ball resting on a plain grey surface.', finalAttempt: true, meter });
console.log(`clean picture:    ${clean.accept ? 'accepted' : `rejected (${clean.problems.join(', ')})`} — ${clean.verdict.reason}`);
console.log(`picture + "BALL": ${lettered.accept ? 'accepted ✗ (should be rejected)' : `rejected (${lettered.problems.join(', ')})`} — ${lettered.verdict.reason}`);

// 5. Optional: two real keyframes — the second in the first one's style.
if (withImage) {
  step('5. keyframe images');
  const STYLE = 'Vintage editorial photograph with muted warm tones, soft diffused window light, gentle film grain, shallow depth of field, the subject centered and fully visible against a plain seamless warm-grey studio backdrop, generous empty space around it. No text, letters, numbers, labels or watermark.';
  const subjects = [
    'A broad green leaf in warm sunlight with water droplets on its surface.',
    'A small potted green plant on a wooden table beside a glass of water.',
  ];
  const imageModels = [...new Set([serverEnv.cloudLessonImageModel, 'gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image'])];
  let imageModel: string | null = null;
  let first: { mimeType: string; data: Buffer } | null = null;
  for (const model of imageModels) {
    try {
      first = await generateImage({ model, prompt: `${subjects[0]} ${STYLE}`, aspectRatio: '16:9', meter });
      imageModel = model;
      console.log(`✓ ${model} works`);
      break;
    } catch (error) {
      const reason = error instanceof GeminiCallError && error.status ? `HTTP ${error.status}` : (error instanceof Error ? error.message.slice(0, 160) : String(error));
      console.log(`✗ ${model}: ${reason}`);
    }
  }
  if (!imageModel || !first) fail('no image model worked — check the key and that billing is enabled on its project');
  if (imageModel !== serverEnv.cloudLessonImageModel) console.log(`→ set CLOUD_LESSON_IMAGE_MODEL=${imageModel} in .env`);
  const second = await generateImage({
    model: imageModel!, prompt: `${subjects[1]} ${STYLE}`, aspectRatio: '16:9', styleReference: first!, meter,
  });
  for (const [index, image] of [first!, second].entries()) {
    const file = path.join(out, `keyframe-${index + 1}.${image.mimeType.includes('jpeg') ? 'jpg' : 'png'}`);
    await writeFile(file, image.data);
    const meta = await sharp(image.data).metadata();
    const verdict = await checkKeyframe({ image, description: subjects[index], finalAttempt: false, meter });
    console.log(`keyframe ${index + 1}: ${meta.width}×${meta.height} → ${path.relative(process.cwd(), file)}  checker: ${verdict.accept ? 'accepted' : `rejected (${verdict.problems.join(', ')})`} — ${verdict.verdict.reason}`);
  }
  console.log('→ open both keyframes: the second should look like the same photo shoot as the first');
}

step('cost');
const summary = meter.summary();
for (const [stage, entry] of Object.entries(summary.byStage)) {
  console.log(`${stage.padEnd(32)} ${String(entry.calls).padStart(2)} call(s)  $${entry.costUsd.toFixed(5)}  ${entry.promptTokens} in / ${entry.outputTokens} out tokens`);
}
console.log(`total $${summary.totalUsd.toFixed(4)}${summary.unpricedCalls ? `  (+${summary.unpricedCalls} call(s) with no known rate)` : ''}`);
console.log('\n✓ Gemini smoke test finished');
