/**
 * LIVE storybook smoke: one real 30-second storybook lesson plan, its
 * storyteller narration, and the first three pictures drawn exactly as the
 * image worker draws them (shot 1 of scene 1 first, then two shots that copy
 * its look). Never touches Supabase or Higgsfield.
 *
 *   npm run smoke:cloud-storybook -- --confirm-spend [--class 7] [--subject History]
 *                                     [--topic "Shivaji Maharaj's escape from Agra"] [--language en-IN]
 *
 * Costs roughly $0.25: the plan and voice (~$0.05) and three 2K pictures with
 * their checks (~$0.16). Writes everything to generated/cloud-storybook/<time>/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { generateImage } from '../src/lib/cloud-lesson/gemini.ts';
import { normalizeKeyframe, STORYBOOK_REFERENCE_INSTRUCTION } from '../src/lib/cloud-lesson/image-worker.ts';
import { prepareCloudLesson } from '../src/lib/cloud-lesson/prepare.ts';
import { CostMeter } from '../src/lib/cloud-lesson/pricing.ts';
import { loadAllCloudLessonSkills } from '../src/lib/cloud-lesson/skills.ts';
import type { CloudLessonStorybookScene } from '../src/lib/cloud-lesson/storybook.ts';
import { checkStorybookShot } from '../src/lib/cloud-lesson/vision.ts';
import { serverEnv } from '../src/lib/env.ts';
import { PrepareCloudLessonInputSchema } from '../src/lib/videos/cloud-lesson-contracts.ts';

// The same wording the database adds to every storybook shot (migration 20261011170000).
const STYLE = 'Black-and-white pen-and-ink engraving illustration in the manner of a nineteenth-century book plate: fine cross-hatching and stippled shading, crisp confident linework, strong contrast, printed on aged cream sepia paper. The drawing runs to every edge of the frame with no border, frame, rounded corners or vignette, and one clear focal point. No text, letters, numbers, captions, banners, labels or watermark.';
const AVOID = 'text, writing, letters, numbers, captions, banners, labels, watermark, logo, border, frame, rounded corners, vignette, colour, color photograph, photorealistic, 3D render, flat vector cartoon, distorted anatomy, extra fingers, duplicate subjects, low quality';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const position = args.indexOf(name);
  return position >= 0 && args[position + 1] && !args[position + 1].startsWith('--') ? args[position + 1] : fallback;
};

if (!args.includes('--confirm-spend')) {
  console.log('This smoke calls LIVE Gemini text, speech and image APIs (about $0.25).\nRun: npm run smoke:cloud-storybook -- --confirm-spend [--class 7] [--subject History] [--topic "Shivaji Maharaj\'s escape from Agra"] [--language en-IN]');
} else {
  const input = PrepareCloudLessonInputSchema.parse({
    classLevel: Number(value('--class', '7')), subject: value('--subject', 'History'),
    topic: value('--topic', "Shivaji Maharaj's escape from Agra"), languageCode: value('--language', 'en-IN'),
    durationSeconds: 30, visualStyle: 'storybook',
  });
  await loadAllCloudLessonSkills();
  const meter = new CostMeter();
  const lesson = await prepareCloudLesson({ input, meter, checkpoint: async (stage, progress) => { console.log(`${String(progress).padStart(2)}% ${stage}`); } });
  const scenes = lesson.scenes as CloudLessonStorybookScene[];
  const directory = path.join(process.cwd(), 'generated', 'cloud-storybook', `${Date.now()}-${input.languageCode}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'narration.wav'), lesson.narration.wav);
  const { narration, ...plan } = lesson;
  await writeFile(path.join(directory, 'lesson.json'), JSON.stringify({ ...plan, narration: { durationSeconds: narration.durationSeconds, scenes: narration.scenes } }, null, 2));
  console.log(`\n${lesson.title}`);
  for (const scene of scenes) {
    console.log(`  ${scene.index}. [${scene.title}] ${scene.motionMode} — ${scene.narration}`);
    for (const [i, shot] of scene.shots.entries()) console.log(`       shot ${i + 1} ${shot.shotSize}/${shot.cameraMove}: ${shot.visualDescription.slice(0, 110)}…`);
  }

  // Shot 1 of scene 1, then two shots that must copy its look.
  const picks = [[0, 0], [0, 1], [1, 0]] as const;
  let reference: { mimeType: string; data: Buffer } | undefined;
  console.log('\npictures:');
  for (const [sceneAt, shotAt] of picks) {
    const shot = scenes[sceneAt].shots[shotAt];
    const generated = await generateImage({
      meter, model: serverEnv.cloudLessonImageModel, aspectRatio: '16:9', imageSize: '2K',
      prompt: `${shot.visualDescription} ${STYLE}\nAvoid: ${AVOID}`,
      ...(reference ? { styleReference: reference, referenceInstruction: STORYBOOK_REFERENCE_INSTRUCTION } : {}),
    });
    const image = await normalizeKeyframe(generated.data);
    const decision = await checkStorybookShot({ meter, image, description: shot.visualDescription, finalAttempt: true });
    const file = path.join(directory, `scene${sceneAt + 1}-shot${shotAt + 1}.png`);
    await writeFile(file, image.data);
    console.log(`  ${path.relative(process.cwd(), file)}  ${decision.problems.length ? `problems: ${decision.problems.join(', ')}` : 'checker: fine'} — ${decision.verdict.reason}`);
    reference ??= image;
  }

  const summary = meter.summary();
  console.log('\ncost:');
  for (const [stage, entry] of Object.entries(summary.byStage)) console.log(`  ${stage.padEnd(32)} ${String(entry.calls).padStart(2)} call(s)  $${entry.costUsd.toFixed(5)}`);
  console.log(`  total $${summary.totalUsd.toFixed(4)}${summary.unpricedCalls ? ` (+${summary.unpricedCalls} unpriced)` : ''}`);
  console.log(`\nOpen ${path.relative(process.cwd(), directory)}: the three pictures should look like one engraver drew them; listen to narration.wav.`);
}
