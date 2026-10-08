/**
 * Run the website's lesson preparation (plan, translate, fit narration,
 * scene-aligned voice) and save the result to files, without touching the
 * database. `ops/runpod/seed_prepared_lesson.py` then queues it for rendering.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prepare-lesson-files.ts \
 *     <outDir> "<topic>" <classLevel> "<subject>" <languageCode>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { videoLanguage, type VideoLanguageCode } from '../src/lib/videos/languages';
import { synthesizeNarration } from '../src/lib/videos/narration';
import {
  adjustNarrationToFit,
  narrationFromPlan,
  planLesson,
  scenesForProject,
  translateLessonPlan,
} from '../src/lib/videos/planner';

async function main() {
  const [outDir, topic, classLevel, subject, language] = process.argv.slice(2);
  if (!outDir || !topic || !classLevel || !subject || !language) {
    throw new Error('Usage: prepare-lesson-files.ts <outDir> <topic> <classLevel> <subject> <languageCode>');
  }
  const input = {
    classLevel: Number(classLevel),
    subject,
    topic,
    languageCode: language as VideoLanguageCode,
    targetDurationSeconds: 60 as const,
  };
  const started = Date.now();
  let sourcePlan = await planLesson(input);
  let plan = await translateLessonPlan(sourcePlan, input.languageCode);
  let narrationText = narrationFromPlan(plan);
  let narration = await synthesizeNarration(narrationText, input.languageCode);
  for (let revision = 0; revision < 2; revision += 1) {
    if (narration.durationSeconds >= 36 && narration.durationSeconds <= 58) break;
    try {
      sourcePlan = await adjustNarrationToFit(sourcePlan, {
        languageCode: input.languageCode,
        measuredDurationSeconds: narration.durationSeconds,
        targetDurationSeconds: 60,
      });
    } catch (error) {
      console.warn('narration length edit failed; keeping current narration', error);
      break;
    }
    plan = await translateLessonPlan(sourcePlan, input.languageCode);
    narrationText = narrationFromPlan(plan);
    narration = await synthesizeNarration(narrationText, input.languageCode, revision === 1 ? 'brisk' : 'natural');
  }
  narration = await synthesizeNarration(narrationText, input.languageCode, 'natural', {
    sceneTranscripts: plan.scenes.map((scene) => scene.narration.trim()),
    targetDurationSeconds: 60,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'narration.wav'), narration.wave);
  writeFileSync(join(outDir, 'lesson.json'), JSON.stringify({
    classLevel: input.classLevel,
    subject,
    topic,
    languageCode: input.languageCode,
    languageName: videoLanguage(input.languageCode).label,
    targetDurationSeconds: 60,
    title: plan.title,
    learningObjective: plan.learningObjective,
    narrationText,
    narrationDurationSeconds: narration.durationSeconds,
    scenes: scenesForProject(plan),
    englishScenes: sourcePlan.scenes.map((scene) => ({ fact: scene.fact, narration: scene.narration, caption: scene.caption })),
  }, null, 2));
  console.log(JSON.stringify({
    outDir,
    seconds: Math.round((Date.now() - started) / 1000),
    narrationSeconds: narration.durationSeconds,
  }));
}

main().catch((error: unknown) => {
  console.error('PREPARE FAILED:', error);
  process.exitCode = 1;
});
