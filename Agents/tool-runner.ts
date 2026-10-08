import 'server-only';

import { analyzeStyleImage } from './tools/analyze-style-image';
import { checkGoogleFont } from './tools/check-google-font';
import { checkOverflow } from './tools/check-overflow';
import { checkWordBudget } from './tools/check-word-budget';
import { createPptx } from './tools/create-pptx';
import { generateImageTool } from './tools/generate-image';
import { readDocument } from './tools/read-document';
import { validatePptx } from './tools/validate-pptx';
import { AgentError, type Tool } from './types';

/**
 * The tool registry.
 *
 * Explicit, not dynamic. A skill's Markdown can name a tool, but it can never
 * introduce one — if it is not in this object, it cannot run. That is the
 * difference between loading a prompt and executing arbitrary code.
 */

// Registered as Tool<unknown, unknown>: the registry is heterogeneous, and a
// caller reaching it by string name has an unknown input shape by definition.
// Call sites that import a tool directly keep its precise types.
const registry: Record<string, Tool<unknown, unknown>> = {
  [analyzeStyleImage.name]: analyzeStyleImage,
  [checkGoogleFont.name]: checkGoogleFont,
  [checkOverflow.name]: checkOverflow,
  [checkWordBudget.name]: checkWordBudget,
  [createPptx.name]: createPptx,
  [generateImageTool.name]: generateImageTool,
  [readDocument.name]: readDocument,
  [validatePptx.name]: validatePptx,
};

export function listTools(): { name: string; description: string }[] {
  return Object.values(registry).map(({ name, description }) => ({ name, description }));
}

export function hasTool(name: string): boolean {
  return name in registry;
}

/**
 * Runs a registered tool. `input` is unknown because it arrives from model
 * output — each tool validates its own shape.
 */
export async function runTool(name: string, input: unknown): Promise<unknown> {
  const tool = registry[name];

  if (!tool) {
    throw new AgentError(`Unknown tool "${name}"`, 'TOOL_NOT_FOUND', 'tool-runner');
  }

  return tool.execute(input);
}
