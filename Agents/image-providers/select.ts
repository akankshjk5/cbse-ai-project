import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { policyEnv, resolveStage } from '@/lib/generation/providers/policy';
import { LocalZImageProvider } from './local-zimage';
import { OpenRouterImageProvider } from './openrouter';
import { ImageProviderError, type ImageProvider } from './types';

/**
 * Which provider draws a slide's picture.
 *
 * One rule, and it is the same rule every other stage already obeys: ask
 * `resolveStage('image')`. On a default deployment that answers `local`,
 * because `ALLOW_EXTERNAL_PROVIDERS` is unset — so a self-hosted install gets
 * its own GPU without configuring anything, and a paid provider needs two
 * switches set deliberately.
 *
 * There is no fallback between them. A local service that is down produces an
 * error naming the service; it does not quietly become a charge at OpenRouter.
 * Falling back across that boundary is how a deployment that believes it is
 * self-hosted discovers otherwise on an invoice.
 */

export interface SelectImageProviderOptions {
  comfyUrl: string;
  /** Directory holding the shipped ComfyUI graphs. */
  workflowDir: string;
  /** Only read when the policy actually selects the external provider. */
  openRouterApiKey?: () => string;
  openRouterModel?: string;
}

export interface SelectedImageProvider {
  provider: ImageProvider;
  /** `local` or `external`, as the policy decided — for the job record. */
  kind: string;
  /** Why this one, in a form a log reader can act on. */
  reason: string;
}

export async function selectImageProvider(
  options: SelectImageProviderOptions,
): Promise<SelectedImageProvider> {
  const stage = resolveStage('image', policyEnv());

  if (stage.kind === 'local' || stage.kind === 'deterministic') {
    const path = join(options.workflowDir, 'image-fast.json');
    let workflow: Record<string, unknown>;
    try {
      workflow = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new ImageProviderError(
        `Could not read the local image workflow at ${path}: ${(error as Error).message}`,
        'CONFIG', 'local-zimage');
    }
    return {
      provider: new LocalZImageProvider({
        comfyUrl: options.comfyUrl, workflow, model: stage.model,
      }),
      kind: stage.kind,
      reason: `policy resolved image to ${stage.id}; no external provider is enabled`,
    };
  }

  // Reached only when both switches are set and `image` is named. The key is
  // read here rather than at module scope, so a deployment without one can
  // still import this file and run locally.
  if (!options.openRouterApiKey) {
    throw new ImageProviderError(
      `Policy selected the external image provider ${stage.id}, but no API key `
      + `accessor was supplied`, 'CONFIG', stage.id);
  }
  return {
    provider: new OpenRouterImageProvider({
      apiKey: options.openRouterApiKey(),
      model: options.openRouterModel ?? stage.model,
    }),
    kind: stage.kind,
    reason: `EXTERNAL_PROVIDERS names image, so ${stage.id} was selected deliberately`,
  };
}
