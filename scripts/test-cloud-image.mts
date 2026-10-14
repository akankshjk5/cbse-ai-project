import assert from 'node:assert/strict';
import sharp from 'sharp';
import { runCloudImageJob, normalizeKeyframe, validateStyleReference, downloadStyleReference, type ImageJob, type CloudImageStore } from '../src/lib/cloud-lesson/image-worker.ts';
import type { GeminiTransport } from '../src/lib/cloud-lesson/gemini.ts';
const png = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: '#4488aa' } }).png().toBuffer();
const job: ImageJob = { id: '11111111-1111-4111-8111-111111111111', project_id: '22222222-2222-4222-8222-222222222222', scene_id: '33333333-3333-4333-8333-333333333333', owner_id: 'user_test', kind: 'image', status: 'processing', worker_id: 'test', attempts: 1, max_attempts: 3, prompt: 'A photograph of water evaporating over a warm lake.', negative_prompt: null, parameters: { sceneIndex: 1 } };
let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
async function run(config: { writing?: boolean; unsafe?: boolean; slowCancel?: boolean; missingReference?: boolean; subject?: boolean; last?: boolean; cancel?: boolean; lost?: boolean; index?: number; uploadCancel?: boolean; completeLost?: boolean; badImage?: boolean; signal?: AbortSignal } = {}) {
  let calls = 0; let uploads = 0; let completes = 0; let failures = 0; let references = 0; let cancelled = false;
  let metadata: Record<string, unknown> = {};
  const current = { ...job, attempts: config.last ? 3 : 1, parameters: { sceneIndex: config.index ?? 1, ...(config.index === 2 && !config.missingReference ? { styleReferenceUrl: 'https://storage.test/image.png' } : {}) } };
  const transport: GeminiTransport = { async generateContent(request) {
    calls++;
    if (config.slowCancel) { await new Promise(resolve => setTimeout(resolve, 30)); cancelled = true; await new Promise(resolve => setTimeout(resolve, 30)); }
    if ((request.config.responseModalities as string[] | undefined)?.includes('IMAGE')) {
      assert.deepEqual(request.config.imageConfig, { aspectRatio: '16:9', imageSize: '2K' });
      assert.equal(request.contents[0].parts.some(p => 'inlineData' in p), config.index === 2);
      return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: (config.badImage ? Buffer.from('invalid') : png).toString('base64') } }] } }], usageMetadata: { candidatesTokenCount: 1680, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1680 }] } };
    }
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ showsSubject: config.subject ?? true, singlePhoto: true, hasWriting: config.writing ?? false, unsafe: config.unsafe ?? false, reason: 'Clear photograph for students.' }) }] } }] };
  } };
  const store: CloudImageStore = {
    async claim() { return current; }, async scene() { return { index: current.parameters.sceneIndex, description: job.prompt }; },
    async reference() { references++; return { mimeType: 'image/png', data: png }; },
    async heartbeat() { return config.lost ? 'lost' : config.cancel || cancelled ? 'cancel' : 'ok'; },
    async upload(_, bytes) { uploads++; assert.equal((await sharp(bytes).metadata()).width, 2560); if (config.uploadCancel) cancelled = true; return 'https://storage.test/result.png'; },
    async complete(_, __, data) { completes++; metadata = data; return !config.completeLost; },
    async fail(_, code) { failures++; assert.ok(['keyframe_rejected', 'preparation_cancel', 'cloud_image_failed'].includes(code)); return true; },
  };
  const result = await runCloudImageJob({ job: current, store, transport, model: 'gemini-nano-banana-2.1', signal: config.signal, retryDelaysMs: [], heartbeatMs: 5 });
  return { result, calls, uploads, completes, failures, references, metadata };
}
await test('accepted image saves and completes with measured cost', async () => { const r = await run(); assert.equal(r.result.status, 'completed'); assert.equal(r.calls, 2); assert.equal(r.completes, 1); assert.ok(r.result.costUsd > 0); });
await test('later scene receives reference bytes', async () => { const r = await run({ index: 2 }); assert.equal(r.references, 1); assert.equal(r.metadata.styleReferenceUsed, true); });
await test('writing never accepted even final attempt', async () => { const r = await run({ writing: true, last: true }); assert.equal(r.result.status, 'failed'); assert.equal(r.uploads, 0); });
await test('off subject rejected before final attempt', async () => { assert.equal((await run({ subject: false })).result.status, 'failed'); });
await test('final off subject accepted with warning', async () => { const r = await run({ subject: false, last: true }); assert.equal(r.result.status, 'completed'); assert.deepEqual(r.metadata.warnings, ['subject not shown']); });
await test('cancel before model spends nothing', async () => { const r = await run({ cancel: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.calls, 0); });
await test('lost ownership does not mutate', async () => { const r = await run({ lost: true }); assert.equal(r.result.status, 'lost'); assert.equal(r.failures + r.completes + r.uploads, 0); });
await test('cancel after upload cannot complete', async () => { const r = await run({ uploadCancel: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.completes, 0); });
await test('false completion treated as lost', async () => { const r = await run({ completeLost: true }); assert.equal(r.result.status, 'lost'); assert.equal(r.failures, 0); });
await test('invalid image fails before upload', async () => { const r = await run({ badImage: true }); assert.equal(r.result.status, 'failed'); assert.equal(r.uploads, 0); });
await test('shutdown leaves lease untouched', async () => { const c = new AbortController(); c.abort(); const r = await run({ signal: c.signal }); assert.equal(r.result.status, 'shutdown'); assert.equal(r.failures, 0); });
await test('small images rejected without upscaling', async () => { const small = await sharp(png).resize(1280, 720).toBuffer(); await assert.rejects(normalizeKeyframe(small), /2K/); });
await test('foreign hosts and projects rejected', async () => {
  const base = 'https://example.supabase.co'; const good = `${base}/storage/v1/object/public/cloud-lesson-assets/${job.project_id}/media/frame.png`;
  assert.equal(validateStyleReference(good, job.project_id, base).href, good);
  for (const bad of [good.replace('example.supabase.co', 'evil.test'), good.replace(job.project_id, job.id), good + '?redirect=evil', good.replace('/media/', '/media/%2e%2e/'), good.replace('https:', 'http:')]) assert.throws(() => validateStyleReference(bad, job.project_id, base));
});
await test('reference downloads refuse non images', async () => {
  const fake = (async () => new Response('no', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await assert.rejects(downloadStyleReference(new URL('https://example.test/frame'), fake));
});
await test('unsafe image rejected on final attempt', async () => { const r = await run({ unsafe: true, last: true }); assert.equal(r.result.status, 'failed'); assert.equal(r.uploads, 0); });
await test('missing reference prevents paid generation', async () => { const r = await run({ index: 2, missingReference: true }); assert.equal(r.result.status, 'failed'); assert.equal(r.calls, 0); });
await test('heartbeat observes cancellation during a slow call', async () => { const r = await run({ slowCancel: true }); assert.equal(r.result.status, 'cancelled'); assert.equal(r.calls, 1); assert.equal(r.uploads, 0); assert.ok(r.result.costUsd > 0); });
await test('portrait cannot be cropped into a misleading widescreen keyframe', async () => { const portrait = await sharp({ create: { width: 2560, height: 3000, channels: 3, background: '#fff' } }).png().toBuffer(); await assert.rejects(normalizeKeyframe(portrait), /widescreen/); });
console.log(`${passed} cloud image tests passed; no API calls.`);
