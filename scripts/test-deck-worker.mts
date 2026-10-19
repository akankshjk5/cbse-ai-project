/**
 * The deck worker's lifecycle, against a FAKE store and a FAKE builder.
 *
 * MOCK, NOT A MODEL AND NOT A DATABASE. The store below records calls and
 * returns values this file chose; the builder writes a small real zip rather
 * than running a planner. No model runs, nothing is uploaded, and no deck here
 * is AI-generated.
 *
 * What it proves: that a finished deck is uploaded and recorded; that an absent
 * planner fails the job with the planner named instead of producing filler;
 * that a cancelled lesson is not built; that a worker whose lease was taken
 * does not overwrite its replacement's work; and that an empty or non-pptx
 * file is caught before it reaches storage rather than in a teacher's hands.
 *
 *   npm run test:deck-worker
 */

import { writeFile } from 'node:fs/promises';

import {
  DECK_MIME,
  DeckStopped,
  contentSlidesFor,
  runCloudDeckJob,
  type CloudDeckStore,
  type DeckJob,
  type DeckRequest,
} from '../src/lib/cloud-lesson/deck-worker.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const JOB: DeckJob = {
  id: '11111111-1111-4111-8111-111111111111',
  project_id: '22222222-2222-4222-8222-222222222222',
  owner_id: 'teacher_1',
  kind: 'deck',
  status: 'processing',
  worker_id: 'deck-worker-test',
  attempts: 1,
  max_attempts: 2,
};

const REQUEST: DeckRequest = {
  classLevel: 9,
  subject: 'Science',
  topic: 'Why ice floats on water',
  language: 'kn-IN',
  objectives: ['Explain why ice floats'],
  contentSlides: 5,
  visualStyle: 'illustrated educational explainer',
  illustrations: 'optional',
};

interface Recorder {
  store: CloudDeckStore;
  uploaded: Buffer[];
  completed: { url: string; metadata: Record<string, unknown> }[];
  failed: { code: string; message: string }[];
  beats: number[];
}

function recorder(overrides: Partial<CloudDeckStore> = {}, heartbeats: ('ok' | 'cancel' | 'lost')[] = []): Recorder {
  const uploaded: Buffer[] = [];
  const completed: { url: string; metadata: Record<string, unknown> }[] = [];
  const failed: { code: string; message: string }[] = [];
  const beats: number[] = [];
  let beat = 0;
  const store: CloudDeckStore = {
    async claim() { return JOB; },
    async request() { return REQUEST; },
    async heartbeat(_job, progress) {
      beats.push(progress);
      return heartbeats[beat++] ?? 'ok';
    },
    async upload(_job, pptx) { uploaded.push(pptx); return 'https://example.test/deck.pptx'; },
    async complete(_job, url, metadata) { completed.push({ url, metadata }); return true; },
    async fail(_job, code, message) { failed.push({ code, message }); return true; },
    ...overrides,
  };
  return { store, uploaded, completed, failed, beats };
}

/** A minimal real zip, so the pptx signature check sees genuine bytes. */
const ZIP = Buffer.from('504b0304140000000800', 'hex');

async function fakeBuild(bytes: Buffer = ZIP, slideCount = 6) {
  return async (_request: DeckRequest, outputPath: string) => {
    await writeFile(outputPath, bytes);
    return {
      path: outputPath, slideCount,
      contentMode: 'original_generated' as const,
      plannerModel: 'qwen3-4b@fake', imagesGenerated: 0, imageFailures: [],
      illustrated: false,
    };
  };
}

// ── Slide count derives from the lesson length, visibly ────────────────────

check(contentSlidesFor(60) === 5, 'a 60-second lesson gets 5 content slides');
check(contentSlidesFor(30) === 3, 'a 30-second lesson gets 3');
console.log(`length: 30s -> ${contentSlidesFor(30)} slides, 60s -> ${contentSlidesFor(60)} slides`);

// ── The happy path ─────────────────────────────────────────────────────────

let r = recorder();
let result = await runCloudDeckJob({ job: JOB, store: r.store, build: await fakeBuild() });

check(result.status === 'succeeded', `expected success, got ${result.status}`);
check(result.slideCount === 6, `the slide count must be reported, got ${result.slideCount}`);
check(r.uploaded.length === 1, 'the deck must be uploaded exactly once');
check(r.completed.length === 1, 'the job must be completed exactly once');
check(r.failed.length === 0, 'a successful job must not record a failure');
check(r.completed[0]!.url === 'https://example.test/deck.pptx', 'the stored URL must be the uploaded one');
console.log('happy path: the deck is built, uploaded once and recorded once');

const meta = r.completed[0]!.metadata;
check(meta.outputKind === 'pptx', 'the metadata must say which output this was');
check(meta.contentMode === 'original_generated', 'provenance must record original content');
check(meta.plannerModel === 'qwen3-4b@fake', 'the planner that wrote it must be recorded');
check(meta.byteSize === ZIP.length, 'the byte size must be recorded');
check(meta.illustrated === false, 'a text-only deck must not be recorded as illustrated');
console.log('provenance: output kind, content mode, planner model, byte size and illustration state');

// Progress is reported in increasing order, so a teacher sees movement.
check(r.beats.length >= 3, `expected at least 3 heartbeats, got ${r.beats.length}`);
check(r.beats.every((v, i) => i === 0 || v >= r.beats[i - 1]!), `progress went backwards: ${r.beats}`);
console.log(`progress: ${r.beats.join(' -> ')} reported across the job`);

// ── An absent planner fails loudly and never produces filler ──────────────

r = recorder();
result = await runCloudDeckJob({
  job: JOB, store: r.store,
  build: async () => { throw new Error('Could not reach the local planner at http://127.0.0.1:18080'); },
});
check(result.status === 'failed', 'an absent planner must fail the job');
check(result.errorCode === 'deck_planner_unavailable',
  `the failure must name the planner, got ${result.errorCode}`);
check(r.uploaded.length === 0, 'nothing may be uploaded when the planner is absent');
check(r.failed.length === 1 && /planner/i.test(r.failed[0]!.message),
  'the recorded failure must mention the planner');
console.log('planner absent: the job fails naming the planner, and nothing is uploaded');

// ── A cancelled lesson is not built ───────────────────────────────────────

r = recorder({ async request() { throw new DeckStopped('cancel'); } });
result = await runCloudDeckJob({ job: JOB, store: r.store, build: await fakeBuild() });
check(result.status === 'cancelled', `a cancelled lesson must report cancelled, got ${result.status}`);
check(r.uploaded.length === 0, 'a cancelled lesson must not upload a deck');
check(r.failed[0]?.code === 'deck_cancelled', 'the cancellation must be recorded as such');
console.log('cancelled: no deck is built and the cancellation is recorded');

// A heartbeat saying 'cancel' mid-build stops it too.
r = recorder({}, ['ok', 'cancel']);
result = await runCloudDeckJob({ job: JOB, store: r.store, build: await fakeBuild() });
check(result.status === 'cancelled', 'a cancel heartbeat must stop the job');
check(r.uploaded.length === 0, 'a cancel heartbeat must prevent the upload');
console.log('cancelled: a cancel arriving mid-job stops it before upload');

// ── A lost lease must not overwrite the replacement's work ────────────────

r = recorder({}, ['lost']);
let threw: unknown = null;
try {
  await runCloudDeckJob({ job: JOB, store: r.store, build: await fakeBuild() });
} catch (error) { threw = error; }
check(threw instanceof DeckStopped, 'a lost lease must throw rather than return');
check((threw as DeckStopped).reason === 'lost', 'the reason must be "lost"');
check(r.uploaded.length === 0, 'a worker that lost its lease must not upload');
check(r.failed.length === 0,
  'a lost worker must NOT record a failure: another worker owns the job and would be marked failed');
console.log('lost lease: the worker stops, uploads nothing, and does not fail the new owner\'s job');

// ── A bad file is caught before storage, not by the teacher ───────────────

for (const [label, bytes, slides, expect] of [
  ['an empty file', Buffer.alloc(0), 6, /empty file/i],
  ['an HTML error page', Buffer.from('<!doctype html><title>500</title>'), 6, /not a \.pptx/i],
  ['a deck with no slides', ZIP, 0, /no slides/i],
] as const) {
  r = recorder();
  result = await runCloudDeckJob({ job: JOB, store: r.store, build: await fakeBuild(bytes, slides) });
  check(result.status === 'failed', `${label} must fail the job`);
  check(r.uploaded.length === 0, `${label} must not reach storage`);
  check(expect.test(r.failed[0]!.message), `${label}: unexpected message ${r.failed[0]!.message}`);
}
console.log('validation: an empty file, an HTML page and a zero-slide deck are all refused before upload');

// ── The content type is the real pptx one ─────────────────────────────────

check(DECK_MIME === 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'the deck must be stored with the OOXML presentation content type');
console.log('storage: the pptx content type is the OOXML presentation type, not octet-stream');

console.log('\nOK — FAKE store and FAKE builder. No model ran, no deck was AI-generated, nothing was uploaded.');
