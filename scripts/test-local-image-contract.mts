/**
 * The local image provider against a mock ComfyUI, end to end.
 *
 * MOCK, NOT A MODEL. The server below speaks ComfyUI's HTTP contract —
 * `POST /prompt`, `GET /history/{id}`, `GET /view` — and returns a real PNG it
 * encodes itself. No GPU is involved, nothing is inferred, and no image here
 * is AI-generated. What this proves is that the client speaks the protocol
 * correctly and fails usefully when the service misbehaves.
 *
 * The one test that could not be written any other way is the last: that a
 * self-hosted run makes no request to any external host. It is asserted by
 * replacing global fetch and recording every hostname touched.
 *
 *   npm run test:local-image
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';

import { LocalZImageProvider } from '../Agents/image-providers/local-zimage.ts';
import { ImageProviderError } from '../Agents/image-providers/types.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const workflow = JSON.parse(
  await readFile('ops/runpod/workflows/api/image-fast.json', 'utf8'));

/** A 1x1 PNG, built here so the mock returns bytes with a real signature. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

interface MockOptions {
  /** What `POST /prompt` answers. */
  promptReply?: unknown;
  /** Skip history entirely, to exercise the deadline. */
  neverFinish?: boolean;
  /** Report the job as failed. */
  failJob?: boolean;
  /** Serve something that is not a PNG from /view. */
  badBytes?: Buffer;
  /** Produce history with no saved image. */
  noOutput?: boolean;
}

interface Mock {
  url: string;
  close: () => Promise<void>;
  submitted: Record<string, unknown>[];
}

async function startMock(options: MockOptions = {}): Promise<Mock> {
  const submitted: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        submitted.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(options.promptReply ?? { prompt_id: 'mock-1' }));
      });
      return;
    }
    if (url.pathname.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (options.neverFinish) { res.end('{}'); return; }
      if (options.failJob) {
        res.end(JSON.stringify({ 'mock-1': { status: { status_str: 'error' } } }));
        return;
      }
      res.end(JSON.stringify({
        'mock-1': {
          status: { status_str: 'success' },
          outputs: options.noOutput ? {} : {
            '10': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
          },
        },
      }));
      return;
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(options.badBytes ?? PNG);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    submitted,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const request = {
  prompts: {
    spec: 'A LONG STRUCTURED BRIEF, many lines, written for a chat model',
    caption: 'a cross-section of a water molecule, flat vector, no text',
  },
  width: 1920, height: 1080, aspectRatio: '16:9' as const,
};

// ── The happy path: serialisation, retrieval, parsing ──────────────────────

let mock = await startMock();
let provider = new LocalZImageProvider({ comfyUrl: mock.url, workflow });
let image = await provider.generate(request);

check(image.data.length === PNG.length, 'the fetched bytes must be what /view served');
check(image.mimeType === 'image/png', 'the local provider returns PNG');
check(image.provider === 'local-zimage', `provider id, got ${image.provider}`);
check(image.usage.costUsd === undefined,
  'self-hosted work has no per-image price; zero would read as a measured free lesson');
console.log('contract: submit, poll, fetch and parse round-trip against the real protocol');

// The graph is serialised the way ComfyUI expects, with the CAPTION dialect.
const body = mock.submitted[0]! as { prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> };
const nodes = Object.values(body.prompt);
const encoder = nodes.find((n) => n.class_type === 'CLIPTextEncode')!;
const sampler = nodes.find((n) => n.class_type === 'KSampler')!;
const latent = nodes.find((n) => n.class_type === 'EmptySD3LatentImage')!;
const unet = nodes.find((n) => n.class_type === 'UNETLoader')!;

check(encoder.inputs!.text === request.prompts.caption,
  `the caption dialect must be sent, got: ${String(encoder.inputs!.text).slice(0, 48)}`);
check(!String(encoder.inputs!.text).includes('STRUCTURED BRIEF'),
  'the long spec dialect must never reach the image model');
check(unet.inputs!.unet_name === 'z_image_turbo_bf16.safetensors',
  `the shipped checkpoint must be selected, got ${unet.inputs!.unet_name}`);
check(latent.inputs!.width === 1920 && latent.inputs!.height === 1080,
  'the requested size must reach the latent node');
check(typeof sampler.inputs!.seed === 'number', 'a seed must be supplied, not left as a slot');
console.log('contract: caption dialect, shipped checkpoint, and size reach the right nodes');

// Sizes that are not multiples of 8 are rounded, because ComfyUI rejects them
// deep in validation with a message about tensor shapes.
await provider.generate({ ...request, width: 1921, height: 1081 });
const rounded = Object.values((mock.submitted[1] as typeof body).prompt)
  .find((n) => n.class_type === 'EmptySD3LatentImage')!;
check(Number(rounded.inputs!.width) % 8 === 0 && Number(rounded.inputs!.height) % 8 === 0,
  `sizes must be rounded to a multiple of 8, got ${rounded.inputs!.width}x${rounded.inputs!.height}`);
console.log('contract: an odd size is rounded before ComfyUI can reject it');
await mock.close();

// ── Failure paths ──────────────────────────────────────────────────────────

async function expectFailure(options: MockOptions, code: string, label: string) {
  const m = await startMock(options);
  const p = new LocalZImageProvider({ comfyUrl: m.url, workflow, deadlineMs: 900, pollMs: 100 });
  let error: ImageProviderError | null = null;
  try { await p.generate(request); } catch (e) { error = e as ImageProviderError; }
  await m.close();
  check(error instanceof ImageProviderError, `${label}: expected ImageProviderError`);
  check(error!.code === code, `${label}: expected ${code}, got ${error!.code}`);
  check(!/openrouter|gemini|higgsfield|fal\./i.test(error!.message),
    `${label}: a local failure must not offer a paid provider as a remedy`);
  return error!;
}

await expectFailure({ promptReply: { error: 'node 4 is missing a required input' } },
  'HTTP', 'refused workflow');
console.log('failure: a refused workflow is reported with ComfyUI\'s own complaint');

const timedOut = await expectFailure({ neverFinish: true }, 'NETWORK', 'deadline');
check(/did not finish in time/.test(timedOut.message), 'the deadline message should say so');
check(/out-of-memory|missing-model/.test(timedOut.message),
  'and should name the two causes worth checking first');
console.log('failure: a job that never finishes hits the deadline and names likely causes');

await expectFailure({ failJob: true }, 'HTTP', 'failed job');
await expectFailure({ noOutput: true }, 'EMPTY', 'no saved image');
console.log('failure: a failed job and an empty output are distinguished');

// A ComfyUI error page is a 200 with HTML in it. Stored unchecked, that
// becomes a slide whose illustration is markup.
const notPng = await expectFailure(
  { badBytes: Buffer.from('<!doctype html><title>500</title>') }, 'EMPTY', 'html body');
check(/not a PNG/.test(notPng.message), 'the message should say the bytes are not a PNG');
console.log('failure: an HTML error page cannot become a slide illustration');

// Unreachable service: the case a self-hosted deployment actually hits.
const dead = new LocalZImageProvider({ comfyUrl: 'http://127.0.0.1:59998', workflow });
let unreachable: ImageProviderError | null = null;
try { await dead.generate(request); } catch (e) { unreachable = e as ImageProviderError; }
check(unreachable!.code === 'NETWORK', 'an unreachable service is a NETWORK failure');
check(/Start it/i.test(unreachable!.message), 'and the message should say what to do');
console.log('failure: an unreachable GPU names the service and the remedy');

// ── No external request in self-hosted mode ────────────────────────────────

mock = await startMock();
const hosts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  hosts.push(new URL(url).hostname);
  return realFetch(input as never, init);
}) as typeof fetch;
try {
  await new LocalZImageProvider({ comfyUrl: mock.url, workflow }).generate(request);
} finally {
  globalThis.fetch = realFetch;
  await mock.close();
}
check(hosts.length > 0, 'the provider should have made requests');
check(hosts.every((h) => h === '127.0.0.1'),
  `self-hosted generation touched a non-local host: ${[...new Set(hosts)].join(', ')}`);
console.log(`isolation: ${hosts.length} requests, all to 127.0.0.1 — nothing left the machine`);

console.log('\nOK — all against a MOCK ComfyUI. No model ran; no image was AI-generated.');
