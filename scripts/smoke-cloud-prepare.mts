/** LIVE Gemini preparation smoke. Never claims DB jobs or queues paid video jobs. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CreateCloudLessonSchema } from '../src/lib/videos/cloud-lesson-contracts.ts';
import { prepareCloudLesson } from '../src/lib/cloud-lesson/prepare.ts';
import { loadAllCloudLessonSkills } from '../src/lib/cloud-lesson/skills.ts';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const position = args.indexOf(name);
  if (position < 0) return fallback;
  if (!args[position + 1] || args[position + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[position + 1];
};
if (!args.includes('--confirm-spend')) {
  console.log('This smoke calls LIVE Gemini text and TTS APIs (including retries); charges vary by model.\nIt writes a plan and narration locally, without Supabase or Higgsfield calls.\nRun: npm run smoke:cloud-prepare -- --confirm-spend [--class 6] [--subject Science] [--topic "Water cycle"] [--language en-IN]');
} else {
  const input = CreateCloudLessonSchema.parse({
    classLevel: Number(value('--class', '6')), subject: value('--subject', 'Science'),
    topic: value('--topic', 'Water cycle'), languageCode: value('--language', 'en-IN'),
  });
  await loadAllCloudLessonSkills();
  const result = await prepareCloudLesson({ input, checkpoint: async (stage, progress) => { console.log(`${progress}% ${stage}`); } });
  const directory = path.join(process.cwd(), 'generated', 'cloud-prepare', `${Date.now()}-${input.languageCode}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'narration.wav'), result.narration.wav);
  const { narration, ...plan } = result;
  await writeFile(path.join(directory, 'lesson.json'), JSON.stringify({ ...plan, narration: { durationSeconds: narration.durationSeconds, scenes: narration.scenes } }, null, 2));
  console.log(`Prepared ${result.scenes.length} scenes; ${result.narration.durationSeconds.toFixed(3)} seconds.\nKnown cost: $${result.costUsd.toFixed(4)}; unpriced calls: ${result.metadata.cost.unpricedCalls}\nOutput: ${directory}`);
}
