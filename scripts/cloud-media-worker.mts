import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { serverEnv } from '../src/lib/env.ts';
import { createHiggsfieldProvider } from '../src/lib/cloud-lesson/higgsfield.ts';
import { createCloudMediaStore, createCloudMediaRenderer, pickLessonMusic, runCloudMediaJob } from '../src/lib/cloud-lesson/media-worker.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run worker:cloud-media -- [--once] [--assemble-only] [--preflight]\nCPU worker for cloud video/assembly queues; video jobs may incur Higgsfield charges.');
} else {
  for (const arg of args) if (!['--once', '--assemble-only', '--preflight'].includes(arg)) throw new Error(`Unsupported argument: ${arg}`);
  const renderer = createCloudMediaRenderer();
  await renderer.preflight(); // Dependencies and all language fonts checked before claiming work.
  if (serverEnv.cloudLessonMusicDir) {
    // Throws now, before any claim, when the folder is wrong; storybook lessons only.
    const track = await pickLessonMusic(serverEnv.cloudLessonMusicDir, 'preflight');
    console.log(track ? 'Storybook music folder is ready.' : 'CLOUD_LESSON_MUSIC_DIR has no .wav or .m4a tracks; storybook lessons will have no music.');
  }
  if (args.includes('--preflight')) {
    console.log('Cloud compositor dependencies and fonts are ready. No API calls made.');
  } else {
    void serverEnv.supabaseServiceRoleKey;
    const provider = args.includes('--assemble-only') ? undefined : createHiggsfieldProvider(serverEnv.cloudLessonHiggsfieldCredentials);
    const store = createCloudMediaStore();
    const workerId = `cloud-media:${hostname()}:${randomUUID()}`;
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    console.log(`Cloud media worker ready (${workerId}), 1080p CPU composition.`);
    try {
      while (!controller.signal.aborted) {
        const job = await store.claim(workerId, args.includes('--assemble-only') ? ['assemble'] : ['video', 'assemble']);
        if (!job) {
          if (args.includes('--once')) break;
          await delay(3_000, undefined, { signal: controller.signal }).catch(() => undefined);
          continue;
        }
        const result = await runCloudMediaJob({ job, store, provider, renderer, signal: controller.signal,
          onStage: (stage, percent) => console.log(`[${job.id}] ${percent}% ${stage}`) });
        console.log(`[${job.id}] ${result.status}; additional estimated provider cost $${result.costUsd.toFixed(4)}`);
        if (args.includes('--once')) break;
      }
    } finally { process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); }
  }
}
