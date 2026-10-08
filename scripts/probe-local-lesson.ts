/**
 * Plan-only diagnostic. This never creates a project or generates media.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe-local-lesson.ts \
 *     "<topic>" [classLevel] [subject] [languageCode]
 */
import { planLesson, PRINTED_MATTER, translateLessonPlan } from '../src/lib/videos/planner';
import type { VideoLanguageCode } from '../src/lib/videos/languages';

async function main() {
  const [topic = 'how python loop works', classLevel = '12', subject = 'Computer Science', language = 'en-IN'] =
    process.argv.slice(2);
  const started = Date.now();
  const plan = await planLesson({
    classLevel: Number(classLevel),
    subject,
    topic,
    languageCode: language as VideoLanguageCode,
    targetDurationSeconds: 60,
  });
  const translated = await translateLessonPlan(plan, language as VideoLanguageCode);
  console.log(JSON.stringify({
    topic,
    seconds: Math.round((Date.now() - started) / 1000),
    scenes: plan.scenes.length,
    invalidVisuals: plan.scenes.filter((scene) => PRINTED_MATTER.test(scene.visualDescription)).length,
    scenesDetail: plan.scenes.map((scene, index) => ({
      fact: scene.fact,
      narration: translated.scenes[index].narration,
      caption: translated.scenes[index].caption,
      overlay: scene.overlay.kind,
      visual: scene.visualDescription,
    })),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error('PROBE FAILED:', error);
  process.exitCode = 1;
});
