import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { serverEnv } from '@/lib/env';

/**
 * Loader for the cloud lesson engine's skills: `Agents/Skills/cloud-lesson/*.md`.
 *
 * The same idea as `Agents/skill-loader.ts` — a specialist is a Markdown file,
 * its prose is the system prompt, its frontmatter names its model — kept in a
 * separate folder with a separate loader on purpose:
 *
 *  - The deck pipeline's `listSkills()` reads only the top level of
 *    `Agents/Skills/`, so it never sees these files, and the deck smoke test's
 *    rule that every specialist declares `reset_to_manager` does not apply.
 *  - These skills run on Gemini directly (AI Studio or Vertex, see
 *    `cloudLessonGeminiBackend` in env.ts), not through OpenRouter, so their
 *    model slugs are `gemini/<model>` and only that prefix is accepted here
 *    (`vertex/<model>` is still read, as an alias).
 *  - They return structured JSON and call no tools, so a `[TOOLS]` block is
 *    refused rather than silently ignored.
 *
 * Prompts use `{{name}}` placeholders. `renderCloudLessonPrompt` fills them and
 * throws on any placeholder left without a value: a prompt that says
 * "Class {{classLevel}}" to the model is a bug, not a lesson.
 */

const SKILLS_DIR = path.join(process.cwd(), 'Agents', 'Skills', 'cloud-lesson');

/** Every cloud lesson specialist, in the order the prep worker runs them. */
export const CLOUD_LESSON_SKILLS = [
  'cloud-lesson-writer',
  'cloud-lesson-fact-auditor',
  'cloud-lesson-math-repair',
  'cloud-lesson-scene-director',
  'cloud-lesson-translator',
  'cloud-lesson-narration-editor',
  'cloud-lesson-keyframe-checker',
  // Storybook style only (pen-and-ink engraving, 2-3 shots per scene).
  'cloud-lesson-storybook-director',
  'cloud-lesson-storybook-checker',
] as const;
export type CloudLessonSkillName = (typeof CLOUD_LESSON_SKILLS)[number];

/** `gemini/<model>`, e.g. `gemini/gemini-3.6-flash`. `vertex/` is accepted as an alias. */
const GEMINI_MODEL = /^(?:gemini|vertex)\/([a-z0-9][a-z0-9.-]*)$/;

/** Frontmatter keys a cloud skill may set. Anything else is refused. */
const ALLOWED_KEYS = new Set(['model', 'temperature', 'thinkingLevel', 'thinkingBudget', 'maxOutputTokens']);

/**
 * Gemini 3.x thinks in named levels; Gemini 2.5 took a token budget. A skill
 * sets one or the other (never both), so an env override back to a 2.5 model
 * still has a way to say how much to think.
 */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface CloudLessonSkill {
  name: CloudLessonSkillName;
  /** The full `gemini/...` slug, after any env override. */
  model: string;
  /** The Gemini model id to send, e.g. `gemini-3.6-flash` — the same on AI Studio and Vertex. */
  modelId: string;
  /**
   * Null = the model's own default, which is what the cloud skills use: Google
   * strongly recommends Gemini 3.x stays at 1.0, and warns that lower values
   * can cause looping or worse reasoning. Zod validation, not a low
   * temperature, is what keeps the answers in shape.
   */
  temperature: number | null;
  /** Gemini 3.x thinking level, or null when the skill uses a budget instead. */
  thinkingLevel: ThinkingLevelName | null;
  /** Gemini 2.5 thinking budget in tokens (0 = off), or null when a level is set. */
  thinkingBudget: number | null;
  maxOutputTokens: number;
  /** The prompt with `{{placeholders}}` still in it. */
  template: string;
  /** Placeholder names the template uses, sorted. */
  placeholders: string[];
}

export class CloudLessonSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudLessonSkillError';
  }
}

function parseFrontmatter(raw: string, name: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new CloudLessonSkillError(`Skill "${name}" has no frontmatter; it must declare a model`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!pair) throw new CloudLessonSkillError(`Skill "${name}" has an unreadable frontmatter line: ${line}`);
    if (!ALLOWED_KEYS.has(pair[1])) {
      throw new CloudLessonSkillError(`Skill "${name}" sets unknown frontmatter key "${pair[1]}"`);
    }
    meta[pair[1]] = pair[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: raw.slice(match[0].length) };
}

function numberSetting(
  meta: Record<string, string>,
  key: string,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (meta[key] === undefined) return fallback;
  const value = Number(meta[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CloudLessonSkillError(`Skill "${name}" sets ${key} to ${meta[key]}; expected ${min}-${max}`);
  }
  return value;
}

/** Parses one skill file. Exported for tests; callers use `loadCloudLessonSkill`. */
export function parseCloudLessonSkill(name: CloudLessonSkillName, raw: string): CloudLessonSkill {
  const { meta, body } = parseFrontmatter(raw, name);

  if (/^\s*\[TOOLS\]\s*$/m.test(body)) {
    throw new CloudLessonSkillError(`Skill "${name}" declares [TOOLS]; cloud lesson skills return JSON only`);
  }

  const model = serverEnv.cloudLessonModelForSkill(name) ?? meta.model;
  if (!model) throw new CloudLessonSkillError(`Skill "${name}" declares no model`);
  const matched = model.match(GEMINI_MODEL);
  if (!matched) {
    throw new CloudLessonSkillError(
      `Skill "${name}" uses model "${model}"; cloud lesson skills need a gemini/<model> slug`,
    );
  }

  const template = body.trim();
  if (template.length < 200) throw new CloudLessonSkillError(`Skill "${name}" has an empty or truncated prompt`);
  const placeholders = [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
  const malformed = template.match(/\{\{(?!\w+\}\})[^}]*\}?\}?/);
  if (malformed) {
    throw new CloudLessonSkillError(`Skill "${name}" has a malformed placeholder: ${malformed[0].slice(0, 40)}`);
  }

  if (meta.thinkingLevel !== undefined && meta.thinkingBudget !== undefined) {
    throw new CloudLessonSkillError(`Skill "${name}" sets both thinkingLevel and thinkingBudget; pick one`);
  }
  let thinkingLevel: ThinkingLevelName | null = null;
  if (meta.thinkingLevel !== undefined) {
    const level = meta.thinkingLevel.toLowerCase();
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new CloudLessonSkillError(
        `Skill "${name}" sets thinkingLevel to ${meta.thinkingLevel}; expected ${THINKING_LEVELS.join(', ')}`,
      );
    }
    thinkingLevel = level as ThinkingLevelName;
  }

  return {
    name,
    model,
    modelId: matched[1],
    temperature: meta.temperature === undefined ? null : numberSetting(meta, 'temperature', name, 1, 0, 2),
    thinkingLevel,
    thinkingBudget: meta.thinkingBudget === undefined ? null : numberSetting(meta, 'thinkingBudget', name, 1024, 0, 24576),
    maxOutputTokens: numberSetting(meta, 'maxOutputTokens', name, 4096, 256, 65536),
    template,
    placeholders,
  };
}

const cache = new Map<CloudLessonSkillName, Promise<CloudLessonSkill>>();

/**
 * One cloud lesson specialist by name. Cached per process: the files are read
 * once by a long-running worker, not on every lesson.
 */
export function loadCloudLessonSkill(name: CloudLessonSkillName): Promise<CloudLessonSkill> {
  if (!(CLOUD_LESSON_SKILLS as readonly string[]).includes(name)) {
    return Promise.reject(new CloudLessonSkillError(`Unknown cloud lesson skill "${name}"`));
  }
  let loading = cache.get(name);
  if (!loading) {
    loading = readFile(path.join(SKILLS_DIR, `${name}.md`), 'utf8')
      .catch(() => {
        throw new CloudLessonSkillError(`Skill "${name}" not found in ${SKILLS_DIR}`);
      })
      .then((raw) => parseCloudLessonSkill(name, raw));
    // A failed load must not be cached forever: the next call retries.
    loading.catch(() => cache.delete(name));
    cache.set(name, loading);
  }
  return loading;
}

/** Every skill, for a startup check: a worker should refuse to start on a bad skill. */
export function loadAllCloudLessonSkills(): Promise<CloudLessonSkill[]> {
  return Promise.all(CLOUD_LESSON_SKILLS.map(loadCloudLessonSkill));
}

export type PromptValues = Record<string, string | number>;

/** Fills every `{{placeholder}}`. Throws if the skill needs a value it was not given. */
export function renderCloudLessonPrompt(skill: CloudLessonSkill, values: PromptValues): string {
  const missing = skill.placeholders.filter((key) => values[key] === undefined || values[key] === '');
  if (missing.length) {
    throw new CloudLessonSkillError(`Skill "${skill.name}" is missing prompt values: ${missing.join(', ')}`);
  }
  return skill.template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key]));
}
