import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHiggsfieldProvider, HIGGSFIELD_MODEL, HiggsfieldError, type HiggsfieldProvider } from '../src/lib/cloud-lesson/higgsfield.ts';
import { assertStorybookShots, mediaAssetUrl, pickLessonMusic, runCloudMediaJob, type MediaJob, type MediaScene, type MediaShot, type CloudMediaStore, type CloudMediaRenderer } from '../src/lib/cloud-lesson/media-worker.ts';

const id = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const providerId = '33333333-3333-4333-8333-333333333333';
const job: MediaJob = { id, project_id: project, scene_id: id, owner_id: 'user_test', kind: 'video', status: 'processing',
  worker_id: 'worker', attempts: 1, max_attempts: 2, provider_request_id: null, cost_usd: 0,
  prompt: 'Start with calm water. Then show steam rising. End with visible vapor.', negative_prompt: 'text, logos',
  source_image_url: 'https://storage.test/image.png', parameters: { motionMode: 'animate', sceneIndex: 1, slotSeconds: 7.5, clipSeconds: 5 } };
const scene: MediaScene = { id, scene_index: 1, duration_seconds: 7.5, caption: 'Water evaporates', overlay: { kind: 'none' },
  status: 'generating_video', motion_mode: 'animate', image_url: job.source_image_url!, video_url: null };
const shotTwo = '44444444-4444-4444-8444-444444444444';
const shots: MediaShot[] = [
  { id, scene_id: id, shot_index: 1, camera_move: 'pan_right', status: 'succeeded', image_url: scene.image_url },
  { id: shotTwo, scene_id: id, shot_index: 2, camera_move: 'push_in', status: 'succeeded', image_url: 'https://storage.test/shot2.png' },
];
let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
async function run(config: { short?: boolean; reuse?: boolean; still?: boolean; assemble?: boolean; resume?: boolean; charged?: boolean; cancel?: boolean;
  lost?: boolean; cancelPoll?: boolean; lostPoll?: boolean; uploadCancel?: boolean; terminal?: boolean; ambiguous?: boolean;
  renderFail?: boolean; completeLost?: boolean; signal?: AbortSignal;
  storybook?: boolean; noShots?: boolean; musicDir?: string; projectId?: string } = {}) {
  const style = config.storybook ? 'storybook' : 'illustrated';
  const manifests: Record<string, unknown>[] = [];
  let submits = 0; let polls = 0; let cancels = 0; let uploads = 0; let completed = 0; let failed = 0; let renders = 0;
  let state: 'ok' | 'cancel' | 'lost' = config.cancel ? 'cancel' : config.lost ? 'lost' : 'ok';
  const persisted: string[] = []; const keys: string[] = []; const downloads: string[] = [];
  let metadata: Record<string, unknown> = {};
  const current: MediaJob = { ...job, kind: config.assemble ? 'assemble' : 'video', project_id: config.projectId ?? project,
    provider_request_id: config.resume ? providerId : null, cost_usd: config.charged ? .175 : 0,
    parameters: config.reuse ? { ...job.parameters, reusedFromProjectId: id, reusedRawVideoUrl: 'https://storage.test/reused.mp4' }
      : config.storybook ? { ...job.parameters, visualStyle: 'storybook', shotCount: 2 } : job.parameters };
  const storyScene = config.storybook ? { title: 'The Escape' } : {};
  const provider: HiggsfieldProvider = {
    async submit(input, key) { submits++; keys.push(key); assert.equal(input.image_url, scene.image_url);
      if (config.ambiguous && submits === 1) throw new HiggsfieldError(503);
      return { status: 'queued', request_id: providerId }; },
    async status(requestId) { assert.equal(requestId, providerId); polls++;
      if (config.cancelPoll || config.lostPoll) { state = config.cancelPoll ? 'cancel' : 'lost';
        await new Promise(resolve => setTimeout(resolve, 30)); return { status: 'in_progress', request_id: providerId }; }
      return config.terminal ? { status: 'failed', request_id: providerId }
        : { status: 'completed', request_id: providerId, video: { url: 'https://cdn.higgs.ai/raw.mp4' } }; },
    async cancel() { cancels++; },
  };
  const store: CloudMediaStore = {
    async claim() { return current; },
    async bundle() { return { language: 'en-IN', durationSeconds: config.short ? 30 : 60, visualStyle: style, narrationUrl: 'https://storage.test/narration.wav',
      scenes: config.assemble ? Array.from({ length: config.short ? 4 : 8 }, (_, i) => ({ ...scene, ...storyScene, scene_index: i + 1,
        video_url: `https://storage.test/${i}.mp4`, status: 'succeeded' })) : [{ ...scene, ...storyScene, motion_mode: config.still ? 'still' : 'animate' }],
      ...(config.storybook && !config.assemble && !config.noShots ? { shots } : {}) }; },
    async heartbeat(_, __, requestId) { if (requestId) persisted.push(requestId); return state; },
    async upload() { uploads++; if (config.uploadCancel) state = 'cancel'; return 'https://storage.test/result.mp4'; },
    async complete(_, __, output) { completed++; metadata = output; return !config.completeLost; },
    async fail(_, code, message) { failed++; assert.ok(code.startsWith('cloud_media') || code === 'higgsfield_failed'); assert.ok(!message.includes('secret')); return true; },
  };
  const renderer: CloudMediaRenderer = { async preflight() {}, async render(manifest) {
    assert.equal(manifest.durationSeconds, config.short ? 30 : 60);
    assert.equal(manifest.visualStyle, style);
    manifests.push(manifest); renders++; if (config.renderFail) throw new Error('secret provider body');
    assert.equal(persisted.includes(providerId), !config.still && !config.assemble && !config.reuse);
    await writeFile(String(manifest.output), 'fake mp4'); return { width: 1920, height: 1080, durationSeconds: config.assemble ? 60 : 7.5 };
  } };
  const result = await runCloudMediaJob({ job: current, store, provider, renderer, heartbeatMs: 5, pollMs: 0,
    usdPerSecond: .035, signal: config.signal, assetUrl: url => new URL(url), musicDir: config.musicDir ?? '',
    download: async (url, path) => { downloads.push(url.href); await writeFile(path, 'fake source'); } });
  return { result, submits, polls, cancels, uploads, completed, failed, renders, persisted, keys, downloads, metadata, manifests };
}
await test('animation persisted, raw retained, scene composed and completed', async () => {
  const r = await run(); assert.equal(r.result.status, 'completed'); assert.equal(r.submits, 1); assert.equal(r.uploads, 2);
  assert.equal(r.result.costUsd, .175); assert.equal(r.metadata.model, HIGGSFIELD_MODEL); assert.ok(r.metadata.rawVideoUrl);
});
await test('30-second assembly sends four scenes, duration and style to the renderer', async () => {
  const r = await run({ short: true, assemble: true });
  assert.equal(r.result.status, 'completed');
  assert.equal(r.downloads.length, 5);
  assert.equal(r.submits, 0);
});
await test('reused animation composes new captions without submitting or polling Higgsfield', async () => {
  const r = await run({ reuse: true }); assert.equal(r.result.status, 'completed');
  assert.equal(r.submits + r.polls, 0); assert.equal(r.result.costUsd, 0);
  assert.equal(r.metadata.rawVideoUrl, 'https://storage.test/reused.mp4'); assert.equal(r.uploads, 1);
});
await test('still never submits paid generation', async () => { const r = await run({ still: true }); assert.equal(r.submits + r.polls, 0); assert.equal(r.result.costUsd, 0); });
await test('resume polls existing request without resubmission', async () => { const r = await run({ resume: true }); assert.equal(r.submits, 0); assert.equal(r.polls, 1); });
await test('ambiguous POST retries same stable idempotency key', async () => { const r = await run({ ambiguous: true }); assert.equal(r.submits, 2); assert.equal(new Set(r.keys).size, 1); assert.equal(r.keys[0], `cloud-lesson:${id}`); });
await test('previously recorded generation cost is not charged twice', async () => { assert.ok((await run({ resume: true, charged: true })).result.costUsd < .000001); });
await test('assembly downloads eight clips plus narration', async () => { const r = await run({ assemble: true }); assert.equal(r.downloads.length, 9); assert.equal(r.submits, 0); assert.equal(r.result.status, 'completed'); });
await test('pre-cancel spends nothing', async () => { const r = await run({ cancel: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.submits, 0); });
await test('lost lease never writes', async () => { const r = await run({ lost: true }); assert.equal(r.result.status, 'lost'); assert.equal(r.failed + r.completed + r.uploads, 0); });
await test('cancellation during polling best-effort cancels request', async () => { const r = await run({ cancelPoll: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.cancels, 1); assert.equal(r.renders, 0); });
await test('lease loss during polling does not cancel replacement request', async () => { const r = await run({ lostPoll: true }); assert.equal(r.result.status, 'lost'); assert.equal(r.cancels + r.failed + r.renders, 0); });
await test('provider terminal failure does not fabricate output', async () => { const r = await run({ terminal: true }); assert.equal(r.result.status, 'failed'); assert.equal(r.uploads, 0); });
await test('render failure records known generation estimate', async () => { const r = await run({ renderFail: true }); assert.equal(r.result.status, 'failed'); assert.ok(r.result.costUsd > 0); });
await test('upload cancellation prevents completion', async () => { const r = await run({ still: true, uploadCancel: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.completed, 0); });
await test('false completion is lost ownership', async () => { const r = await run({ completeLost: true }); assert.equal(r.result.status, 'lost'); assert.equal(r.failed, 0); });
await test('shutdown leaves queue lease for recovery', async () => { const c = new AbortController(); c.abort(); const r = await run({ signal: c.signal }); assert.equal(r.result.status, 'shutdown'); assert.equal(r.failed, 0); });
await test('source host/project and provider suffix restrictions', async () => {
  const base = 'https://example.supabase.co'; const valid = `${base}/storage/v1/object/public/cloud-lesson-assets/${project}/media/x.mp4`;
  assert.equal(mediaAssetUrl(valid, project, base).href, valid);
  for (const bad of [valid.replace(project, id), valid.replace('example.supabase.co', 'evil.test'), valid + '?x=y']) assert.throws(() => mediaAssetUrl(bad, project, base));
  assert.throws(() => mediaAssetUrl('https://evilcloudfront.net/x.mp4', project, base, ['cloudfront.net']));
  assert.equal(mediaAssetUrl('https://cdn.higgs.ai/x.mp4?sig=ok', project, base, ['higgs.ai']).hostname, 'cdn.higgs.ai');
});
await test('provider sends documented fixed five-second request and auth', async () => {
  const fake = (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `https://api.higgsfield.ai/${HIGGSFIELD_MODEL}`);
    const headers = options!.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Key key:secret'); assert.equal(headers['Idempotency-Key'], 'stable');
    assert.equal(JSON.parse(String(options!.body)).duration, 5); assert.equal(options!.redirect, 'error');
    return Response.json({ request_id: providerId, status: 'queued' });
  }) as typeof fetch;
  await createHiggsfieldProvider('key:secret', fake).submit({ prompt: job.prompt, image_url: scene.image_url, negative_prompt: '' }, 'stable');
});
await test('provider errors are sanitized and status IDs are checked', async () => {
  await assert.rejects(createHiggsfieldProvider('key:secret', (async () => new Response('secret', { status: 403 })) as typeof fetch).status(providerId), HiggsfieldError);
  await assert.rejects(createHiggsfieldProvider('key:secret', (async () => Response.json({ request_id: id, status: 'completed' })) as typeof fetch).status(providerId));
});

// ── Storybook (S6): shots in, the storybook compositor, a music bed at assembly ──
await test('storybook animated scene downloads both shots, animates shot 1 and sends shots to the renderer', async () => {
  const r = await run({ storybook: true });
  assert.equal(r.result.status, 'completed'); assert.equal(r.submits, 1);
  assert.deepEqual(r.downloads.slice(0, 2), [scene.image_url, 'https://storage.test/shot2.png'], 'shot 1 is fetched once, as a shot');
  assert.equal(r.downloads.length, 3, 'two shots plus the Higgsfield clip');
  const manifest = r.manifests[0]; const sent = manifest.shots as { image: string; cameraMove: string }[];
  assert.deepEqual(sent.map(s => s.cameraMove), ['pan_right', 'push_in']);
  assert.equal(manifest.image, sent[0].image); assert.ok(manifest.rawClip);
  assert.equal((manifest.scene as MediaScene).title, 'The Escape');
});
await test('storybook still scene composes two shots without paying for animation', async () => {
  const r = await run({ storybook: true, still: true });
  assert.equal(r.result.status, 'completed'); assert.equal(r.submits + r.polls, 0); assert.equal(r.result.costUsd, 0);
  assert.equal((r.manifests[0].shots as unknown[]).length, 2); assert.equal(r.manifests[0].rawClip, undefined);
});
await test('storybook reuse copies the earlier animation and still composes both shots', async () => {
  const r = await run({ storybook: true, reuse: true });
  assert.equal(r.result.status, 'completed'); assert.equal(r.submits + r.polls, 0);
  assert.ok(r.downloads.includes('https://storage.test/reused.mp4')); assert.equal((r.manifests[0].shots as unknown[]).length, 2);
});
await test('storybook scene without its shots fails before any spend', async () => {
  const r = await run({ storybook: true, noShots: true });
  assert.equal(r.result.status, 'failed'); assert.equal(r.submits + r.renders, 0);
});
await test('storybook assembly picks one music track per lesson, the same one on a retry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cloud-music-'));
  try {
    for (const name of ['a.wav', 'b.m4a', 'c.wav', 'notes.txt', '.hidden.wav']) await writeFile(join(folder, name), 'x');
    const first = await run({ storybook: true, assemble: true, short: true, musicDir: folder });
    const again = await run({ storybook: true, assemble: true, short: true, musicDir: folder });
    assert.equal(first.result.status, 'completed');
    const track = String(first.manifests[0].music);
    assert.ok(track.startsWith(folder) && /[abc]\.(wav|m4a)$/.test(track), track);
    assert.equal(again.manifests[0].music, track); assert.equal(first.metadata.musicTrack, track.slice(folder.length + 1));
    const tracks = new Set<string>();
    for (let n = 0; n < 12; n++) tracks.add(String(await pickLessonMusic(folder, `5555555${n.toString(16)}-5555-4555-8555-555555555555`)));
    assert.ok(tracks.size > 1, 'different lessons get different tracks');
    const plain = await run({ assemble: true, short: true, musicDir: folder });
    assert.equal(plain.manifests[0].music, undefined, 'illustrated lessons never get music');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
await test('storybook assembly without a music folder is narration only', async () => {
  const r = await run({ storybook: true, assemble: true });
  assert.equal(r.result.status, 'completed'); assert.equal(r.manifests[0].music, undefined); assert.equal(r.downloads.length, 9);
});
await test('music folder misconfiguration is refused, an empty folder is silence', async () => {
  await assert.rejects(pickLessonMusic(join(tmpdir(), 'no-such-music-folder-x'), project), /CLOUD_LESSON_MUSIC_DIR/);
  const empty = await mkdtemp(join(tmpdir(), 'cloud-music-'));
  try { assert.equal(await pickLessonMusic(empty, project), undefined); } finally { await rm(empty, { recursive: true, force: true }); }
  assert.equal(await pickLessonMusic(undefined, project), undefined);
});
await test('storybook shot checks refuse mismatched, missing or reordered shots', async () => {
  const titled = { ...scene, title: 'The Escape' };
  const fresh: MediaJob = { ...job, parameters: { ...job.parameters, visualStyle: 'storybook', shotCount: 2 } };
  assertStorybookShots(shots, titled, fresh);
  assertStorybookShots(shots, titled, { ...job, parameters: { ...job.parameters, reusedFromProjectId: id } });
  const bad: [MediaShot[], MediaScene, MediaJob][] = [
    [[shots[0]], titled, fresh],
    [[shots[1], shots[0]], titled, fresh],
    [[{ ...shots[0], image_url: 'https://storage.test/other.png' }, shots[1]], titled, fresh],
    [[shots[0], { ...shots[1], scene_id: shotTwo }], titled, fresh],
    [shots, { ...scene, title: null }, fresh],
    [shots, titled, { ...fresh, parameters: { ...fresh.parameters, shotCount: 3 } }],
    [shots, titled, job],
  ];
  for (const [list, s, j] of bad) assert.throws(() => assertStorybookShots(list, s, j), /storybook shots/);
});
console.log(`${passed} cloud media tests passed; no API calls or database writes.`);
