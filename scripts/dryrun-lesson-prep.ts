/**
 * Preparation dry run: the same plan -> translate -> voice steps as
 * POST /api/lesson-videos, without creating a project or any media.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/dryrun-lesson-prep.ts \
 *     "<topic>" [classLevel] [subject] [languageCode]
 */
import { synthesizeNarration } from '../src/lib/videos/narration';
import { narrationFromPlan, planLesson, translateLessonPlan } from '../src/lib/videos/planner';
import type { VideoLanguageCode } from '../src/lib/videos/languages';

async function main() {
  const [topic = 'micro controller', classLevel = '12', subject = 'Computer Science', language = 'en-IN'] =
    process.argv.slice(2);
  const languageCode = language as VideoLanguageCode;
  const started = Date.now();
  const plan = await translateLessonPlan(await planLesson({
    classLevel: Number(classLevel), subject, topic, languageCode, targetDurationSeconds: 60,
  }), languageCode);
  const planned = Date.now();
  const narration = await synthesizeNarration(narrationFromPlan(plan), languageCode, 'natural', {
    sceneTranscripts: plan.scenes.map((scene) => scene.narration.trim()),
    targetDurationSeconds: 60,
  });
  console.log(JSON.stringify({
    topic,
    ok: true,
    planningSeconds: Math.round((planned - started) / 1000),
    voiceSeconds: Math.round((Date.now() - planned) / 1000),
    narrationSeconds: narration.durationSeconds,
    scenes: plan.scenes.map((scene) => ({ caption: scene.caption, overlay: scene.overlay.kind, narration: scene.narration })),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error('DRY RUN FAILED:', error);
  process.exitCode = 1;
});
