/**
 * Which image provider gets selected, and what happens when it cannot run.
 *
 * No GPU is needed for any of this, and no picture is generated: these cover
 * selection, workflow filling, and the failure paths. Whether Z-Image produces
 * usable slide art is a different question that needs a card and a person
 * looking at the result.
 *
 *   npm run test:image-provider
 */

import { readFile } from 'node:fs/promises';

import { LocalZImageProvider, fillWorkflow } from '../Agents/image-providers/local-zimage.ts';
import { selectImageProvider } from '../Agents/image-providers/select.ts';
import { ImageProviderError } from '../Agents/image-providers/types.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const WORKFLOWS = 'ops/runpod/workflows/api';
const workflow = JSON.parse(await readFile(`${WORKFLOWS}/image-fast.json`, 'utf8'));

function clearPolicy() {
  delete process.env.ALLOW_EXTERNAL_PROVIDERS;
  delete process.env.EXTERNAL_PROVIDERS;
}

// ── Selection follows the policy, and defaults to local ────────────────────

clearPolicy();
let selected = await selectImageProvider({
  comfyUrl: 'http://127.0.0.1:8188', workflowDir: WORKFLOWS,
});
check(selected.provider.id === 'local-zimage',
  `a default deployment must select the local provider, got ${selected.provider.id}`);
check(selected.kind === 'local', `expected kind local, got ${selected.kind}`);
console.log('selection: a deployment that configured nothing gets its own GPU');

// One switch is not enough — that is the whole point of having two.
process.env.ALLOW_EXTERNAL_PROVIDERS = 'true';
selected = await selectImageProvider({ comfyUrl: 'http://127.0.0.1:8188', workflowDir: WORKFLOWS });
check(selected.provider.id === 'local-zimage',
  'ALLOW_EXTERNAL_PROVIDERS alone must not switch the image provider');
process.env.EXTERNAL_PROVIDERS = 'image';
selected = await selectImageProvider({
  comfyUrl: 'http://127.0.0.1:8188', workflowDir: WORKFLOWS,
  openRouterApiKey: () => 'test-key-not-real',
});
check(selected.provider.id === 'openrouter',
  `both switches set must select the external provider, got ${selected.provider.id}`);
check(selected.reason.includes('deliberately'), 'the reason should say it was deliberate');
console.log('selection: both switches are required before a paid provider is used');

// Selecting the paid provider without a key accessor fails loudly rather than
// reading one from somewhere and charging for it.
let refused = false;
try {
  await selectImageProvider({ comfyUrl: 'http://127.0.0.1:8188', workflowDir: WORKFLOWS });
} catch (error) {
  refused = error instanceof ImageProviderError && error.code === 'CONFIG';
}
check(refused, 'external selection without a key accessor must be refused');
clearPolicy();
console.log('selection: the paid provider needs its key passed in, never found implicitly');

// ── No silent fallback ─────────────────────────────────────────────────────

const unreachable = new LocalZImageProvider({
  comfyUrl: 'http://127.0.0.1:59999', workflow,
});
let caught: ImageProviderError | null = null;
try {
  await unreachable.generate({
    prompts: { spec: 'a diagram', caption: 'a diagram of a water molecule' },
    width: 1920, height: 1080, aspectRatio: '16:9',
  });
} catch (error) {
  caught = error as ImageProviderError;
}
check(caught instanceof ImageProviderError, 'an unreachable ComfyUI must raise ImageProviderError');
check(caught!.code === 'NETWORK', `expected NETWORK, got ${caught!.code}`);
check(caught!.provider === 'local-zimage', 'the error must name the local provider');
check(/start it|deliberately/i.test(caught!.message),
  `the message should say what to do: ${caught!.message}`);
check(!/openrouter|gemini|higgsfield|fal\./i.test(caught!.message),
  'a local failure must not mention a paid provider as a remedy');
console.log('failure: an unreachable GPU is an error naming the service, not a fallback');

// ── Workflow filling ───────────────────────────────────────────────────────

const filled = fillWorkflow(workflow, {
  prompt: 'a cross-section of a water molecule, flat vector, no text',
  width: 1920, height: 1088, seed: 7,
}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
const sampler = Object.values(filled).find((n) => n.class_type === 'KSampler')!;
const text = Object.values(filled).find((n) => n.class_type === 'CLIPTextEncode')!;
check(sampler.inputs!.seed === 7, 'the seed must reach the sampler');
check(String(text.inputs!.text).startsWith('a cross-section'), 'the prompt must reach the encoder');
console.log('workflow: the shipped image-fast graph fills from the provider request');

let missing = false;
try { fillWorkflow(workflow, { prompt: 'x' }); } catch { missing = true; }
check(missing, 'an unfilled slot must be refused rather than submitted');

// A caption that looks like a slot is content, not a placeholder.
const sneaky = fillWorkflow(workflow, {
  prompt: '__SEED__', width: 64, height: 64, seed: 3,
}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
const sneakySampler = Object.values(sneaky).find((n) => n.class_type === 'KSampler')!;
const sneakyText = Object.values(sneaky).find((n) => n.class_type === 'CLIPTextEncode')!;
check(sneakySampler.inputs!.seed === 3 && sneakyText.inputs!.text === '__SEED__',
  'a caption containing a slot token must be accepted verbatim');
console.log('workflow: an unfilled slot is refused; a caption that looks like one is not');

// ── Prompt dialect ─────────────────────────────────────────────────────────

check(new LocalZImageProvider({ comfyUrl: 'http://x', workflow }).promptStyle === 'caption',
  'Z-Image takes a caption, not the long spec dialect written for a chat model');
console.log('dialect: the local provider asks for the caption prompt');

console.log('\nOK');
