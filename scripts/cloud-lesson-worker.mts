/** Cloud lesson preparation worker; no RunPod services or GPU required. */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { serverEnv } from '../src/lib/env.ts';
import { loadAllCloudLessonSkills } from '../src/lib/cloud-lesson/skills.ts';
import { createCloudPreparationStore, runCloudPreparationJob } from '../src/lib/cloud-lesson/worker.ts';
import { createCloudImageStore, runCloudImageJob } from '../src/lib/cloud-lesson/image-worker.ts';

const args = process.argv.slice(2);
const kind = args[args.indexOf('--kinds') + 1] === 'image' ? 'image' : 'prepare';
if (args.includes('--help')) {
  console.log('Usage: npm run worker:cloud-prepare -- [--kinds prepare|image] [--once]\nProcesses queued cloud lesson jobs. --once processes at most one job and exits.');
} else {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--once') continue;
    if (args[index] === '--kinds' && ['prepare', 'image'].includes(args[index + 1])) { index += 1; continue; }
    throw new Error(`Unsupported argument: ${args[index]}. Supported kinds: prepare or image.`);
  }
  await loadAllCloudLessonSkills();
  // Fail before claiming a job when configuration is incomplete.
  void serverEnv.cloudLessonGeminiApiKey;
  void serverEnv.supabaseServiceRoleKey;
  const store = kind === 'image' ? createCloudImageStore() : createCloudPreparationStore();
  const workerId = `cloud-${kind}:${hostname()}:${randomUUID()}`;
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`Cloud lesson worker ready (${workerId}); Gemini backend: ${serverEnv.cloudLessonGeminiBackend}`);
  try {
    while (!controller.signal.aborted) {
      const job = await store.claim(workerId);
      if (!job) {
        if (args.includes('--once')) break;
        await delay(3_000, undefined, { signal: controller.signal }).catch(() => undefined);
        continue;
      }
      const onStage = (stage: string, progress: number) => console.log(`[${job.id}] ${progress}% ${stage}`);
      const result = job.kind === 'image'
        ? await runCloudImageJob({ job, store: store as ReturnType<typeof createCloudImageStore>, signal: controller.signal, onStage })
        : await runCloudPreparationJob({ job, store: store as ReturnType<typeof createCloudPreparationStore>, signal: controller.signal, onStage });
      console.log(`[${job.id}] ${result.status}; known Gemini cost $${result.costUsd.toFixed(4)}`);
      if (args.includes('--once')) break;
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
