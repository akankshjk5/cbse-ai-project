import 'server-only';

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { serverEnv } from '@/lib/env';
import { AgentError } from './types';

/**
 * Loads the Markdown-defined specialists in ./Skills.
 *
 * Each file is one specialist: the prose above `[TOOLS]` becomes its system
 * prompt, and the JSON block under `[TOOLS]` declares the tools it may call.
 * Skills are data, not code — a skill can never introduce a new capability on
 * its own, only name tools the runner already registered. That is what keeps
 * "load a Markdown file" from being arbitrary code execution.
 */

const SKILLS_DIR = path.join(process.cwd(), 'Agents', 'Skills');

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LoadedSkill {
  /** Slug taken from the filename, e.g. `style-analyzer`. */
  name: string;
  systemPrompt: string;
  tools: ToolDeclaration[];
  /**
   * Model slug from the skill's frontmatter, if it declares one. Undefined
   * means "whatever the caller's default is" — usually `OPENROUTER_MODEL`.
   */
  model?: string;
}

/** Pulls the first ```json fenced block out of `section`. */
function extractJsonBlock(section: string): string | null {
  const fence = section.match(/```json\s*([\s\S]*?)```/);
  return fence ? fence[1] : null;
}

/** Model slugs are `provider/model` with an optional `:variant` suffix. */
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/i;

/**
 * Splits an optional `---` frontmatter block off the top of a skill file.
 *
 * Deliberately not a YAML parser: the only thing frontmatter carries here is a
 * handful of `key: value` scalars, and a full parser would let a Markdown file
 * express far more than a skill is allowed to.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^['"]|['"]$/g, '');
  }

  return { meta, body: raw.slice(match[0].length) };
}

function parseSkill(name: string, rawFile: string): LoadedSkill {
  const { meta, body: raw } = parseFrontmatter(rawFile);

  // Env wins over frontmatter: a retired slug must be fixable without a deploy.
  let model: string | undefined = serverEnv.modelForSkill(name);

  if (!model && meta.model) {
    if (!MODEL_SLUG.test(meta.model)) {
      throw new AgentError(
        `Skill "${name}" declares model "${meta.model}", which is not a provider/model slug`,
        'SKILL_MODEL_INVALID',
        'skill-loader',
      );
    }
    model = meta.model;
  }

  const marker = raw.indexOf('[TOOLS]');

  // A skill with no [TOOLS] section is legal — it just has no tools of its own.
  if (marker === -1) {
    return { name, systemPrompt: raw.trim(), tools: [], model };
  }

  const systemPrompt = raw.slice(0, marker).trim();
  const json = extractJsonBlock(raw.slice(marker));

  if (!json) {
    throw new AgentError(
      `Skill "${name}" has a [TOOLS] section with no \`\`\`json block`,
      'SKILL_TOOLS_UNPARSEABLE',
      'skill-loader',
    );
  }

  let tools: ToolDeclaration[];
  try {
    tools = JSON.parse(json) as ToolDeclaration[];
  } catch (error) {
    throw new AgentError(
      `Skill "${name}" has an invalid [TOOLS] JSON block: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'SKILL_TOOLS_INVALID_JSON',
      'skill-loader',
    );
  }

  if (!Array.isArray(tools)) {
    throw new AgentError(
      `Skill "${name}" [TOOLS] block must be a JSON array`,
      'SKILL_TOOLS_NOT_ARRAY',
      'skill-loader',
    );
  }

  return { name, systemPrompt, tools, model };
}

/** Loads one specialist by slug (the filename without `.md`). */
export async function loadSkill(name: string): Promise<LoadedSkill> {
  // Reject anything that could escape SKILLS_DIR — the slug is the only part
  // of this path a caller controls.
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new AgentError(`Invalid skill name "${name}"`, 'SKILL_NAME_INVALID', 'skill-loader');
  }

  const file = path.join(SKILLS_DIR, `${name}.md`);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new AgentError(`Skill "${name}" not found at ${file}`, 'SKILL_NOT_FOUND', 'skill-loader');
  }

  return parseSkill(name, raw);
}

/** Every specialist in ./Skills, for the Manager to choose between. */
export async function listSkills(): Promise<LoadedSkill[]> {
  const files = await readdir(SKILLS_DIR);
  const slugs = files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  return Promise.all(slugs.map(loadSkill));
}
