/**
 * The deck worker.
 *
 *   npm run worker:cloud-deck
 *   npm run worker:cloud-deck -- --once        claim at most one job, then exit
 *   npm run worker:cloud-deck -- --preflight   check the planner, claim nothing
 *
 * Claims 'deck' jobs and nothing else, so it can be run on a box with a
 * planner but no ComfyUI — a deck needs the planner and, optionally, the image
 * service; it never needs Wan.
 *
 * It spends no money. The deck path resolves `plan` and `image` through the
 * provider policy, which answers local unless both external switches are set,
 * and the factories refuse to build a paid client that was not opted into.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { localPlannerReachable } from '../Agents/local-planner.ts';
import { DeckStopped, createCloudDeckStore, runCloudDeckJob } from '../src/lib/cloud-lesson/deck-worker.ts';

const args = process.argv.slice(2);
const once = args.includes('--once');

if (args.includes('--preflight')) {
  const up = await localPlannerReachable();
  console.log(up
    ? 'Local planner is reachable. No job was claimed and no API call was made.'
    : 'Local planner is NOT reachable. Start it before running the worker; '
      + 'deck jobs would fail with deck_planner_unavailable.');
  process.exit(up ? 0 : 1);
}

const store = createCloudDeckStore();
const workerId = `cloud-deck:${hostname()}:${randomUUID()}`;
const controller = new AbortController();
const shutdown = () => controller.abort();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[${workerId}] claiming deck jobs`);

let idle = 0;
while (!controller.signal.aborted) {
  let job;
  try {
    job = await store.claim(workerId);
  } catch (error) {
    console.error(`[${workerId}] could not claim: ${(error as Error).message}`);
    await delay(5_000, undefined, { signal: controller.signal }).catch(() => {});
    continue;
  }

  if (!job) {
    if (once) break;
    idle += 1;
    // Back off to 15s after a minute of nothing, so an idle worker is not a
    // steady stream of queries against the lessons table.
    await delay(idle > 12 ? 15_000 : 5_000, undefined, { signal: controller.signal })
      .catch(() => {});
    continue;
  }
  idle = 0;

  try {
    const result = await runCloudDeckJob({ job, store, signal: controller.signal });
    console.log(`[${job.id}] ${result.status}`
      + (result.slideCount ? ` · ${result.slideCount} slides` : '')
      + (result.errorCode ? ` · ${result.errorCode}` : '')
      + (result.url ? ` · ${result.url}` : ''));
  } catch (error) {
    if (error instanceof DeckStopped) {
      // 'lost' means another worker owns the job now, and 'shutdown' means we
      // are stopping. Neither is this worker's failure to report, and writing
      // one would mark the new owner's work failed.
      console.log(`[${job.id}] released (${error.reason})`);
    } else {
      console.error(`[${job.id}] unexpected: ${(error as Error).message}`);
    }
  }

  if (once) break;
}

console.log(`[${workerId}] stopped`);
