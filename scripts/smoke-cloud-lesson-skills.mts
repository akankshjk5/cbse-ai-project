/**
 * Deterministic smoke test for the cloud lesson skills — no network, no cost.
 *
 *   npm run smoke:cloud-skills
 *
 * Checks that every skill in Agents/Skills/cloud-lesson/ loads, names a
 * gemini/ model, renders with no placeholder left over, honours its env
 * override, refuses bad files — and that the deck pipeline's own skill loader
 * still sees exactly the deck specialists and none of these.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { listSkills } from '../Agents/skill-loader.ts';
import {
  CLOUD_LESSON_SKILLS,
  CloudLessonSkillError,
  loadAllCloudLessonSkills,
  parseCloudLessonSkill,
  renderCloudLessonPrompt,
} from '../src/lib/cloud-lesson/skills.ts';

const values = {
  durationSeconds: 60,
  classLevel: 7,
  subject: 'Science',
  topic: 'How plants make food',
  sceneCount: 8, visualStyle: 'illustrated', animationCap: 3,
  sceneSeconds: 7.5,
  languageName: 'Kannada',
  direction: 'too long',
  targetWords: 11,
  shotsPerScene: 2,
};

// 1. Every skill loads and renders cleanly.
const skills = await loadAllCloudLessonSkills();
assert.equal(skills.length, CLOUD_LESSON_SKILLS.length);
console.log(`cloud lesson skills: ${skills.length}`);
for (const skill of skills) {
  assert.match(skill.model, /^gemini\/gemini-/, `${skill.name} model`);
  const prompt = renderCloudLessonPrompt(skill, values);
  assert.ok(!/\{\{\w+\}\}/.test(prompt), `${skill.name} left a placeholder unfilled`);
  assert.ok(prompt.includes('[OUTPUT]'), `${skill.name} has no [OUTPUT] section`);
  assert.ok(skill.thinkingLevel, `${skill.name} should set a Gemini 3.x thinkingLevel`);
  assert.ok(!/^gemini-2\./.test(skill.modelId), `${skill.name} names a Gemini 2.x model, closed to new accounts`);
  console.log(
    `  ${skill.name.padEnd(30)} ${skill.modelId.padEnd(22)} temp ${skill.temperature ?? 'default'}  `
    + `thinking ${String(skill.thinkingLevel ?? skill.thinkingBudget).padEnd(7)}  out ${skill.maxOutputTokens}  `
    + `${prompt.length} chars  {{${skill.placeholders.join(', ')}}}`,
  );
}

// 2. A missing value is an error, not a prompt that says "Class {{classLevel}}".
const writer = skills.find((skill) => skill.name === 'cloud-lesson-writer')!;
assert.throws(
  () => renderCloudLessonPrompt(writer, { ...values, classLevel: '' }),
  (error: unknown) => error instanceof CloudLessonSkillError && /classLevel/.test(error.message),
);

// 3. The env override wins, must still be a gemini/ model, and vertex/ is read as an alias.
const translatorFile = await readFile(
  path.join(process.cwd(), 'Agents', 'Skills', 'cloud-lesson', 'cloud-lesson-translator.md'),
  'utf8',
);
process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR = 'gemini/gemini-3.1-pro-preview';
assert.equal(parseCloudLessonSkill('cloud-lesson-translator', translatorFile).modelId, 'gemini-3.1-pro-preview');
process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR = 'vertex/gemini-3.1-pro-preview';
assert.equal(parseCloudLessonSkill('cloud-lesson-translator', translatorFile).modelId, 'gemini-3.1-pro-preview');
process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR = 'google/gemini-3.1-pro-preview';
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', translatorFile), CloudLessonSkillError);
delete process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR;

// 4. Bad files are refused.
const withKey = translatorFile.replace('maxOutputTokens:', 'tools: yes\nmaxOutputTokens:');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', withKey), /unknown frontmatter key/);
const withTools = `${translatorFile}\n[TOOLS]\n\`\`\`json\n[]\n\`\`\`\n`;
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', withTools), /\[TOOLS\]/);
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', 'no frontmatter'), /frontmatter/);
const hot = translatorFile.replace('maxOutputTokens:', 'temperature: 9\nmaxOutputTokens:');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', hot), /temperature/);
const both = translatorFile.replace('maxOutputTokens:', 'thinkingBudget: 512\nmaxOutputTokens:');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', both), /both thinkingLevel and thinkingBudget/);
const badLevel = translatorFile.replace('thinkingLevel: low', 'thinkingLevel: extreme');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', badLevel), /thinkingLevel/);
// A 2.5 skill still loads with a budget and no level.
const legacy = translatorFile.replace('thinkingLevel: low', 'thinkingBudget: 1024');
assert.equal(parseCloudLessonSkill('cloud-lesson-translator', legacy).thinkingBudget, 1024);

// 5. The deck pipeline is untouched: its loader sees none of these files.
const deckSkills = await listSkills();
assert.ok(deckSkills.every((skill) => !skill.name.startsWith('cloud-lesson')), 'deck loader saw a cloud skill');
console.log(`deck skills unchanged: ${deckSkills.length} (${deckSkills.map((s) => s.name).join(', ')})`);

// 6. The storybook skills are separate files, so the existing styles' prompts are unchanged.
const storybookDirector = skills.find((skill) => skill.name === 'cloud-lesson-storybook-director')!;
const storybookPrompt = renderCloudLessonPrompt(storybookDirector, values);
assert.match(storybookPrompt, /exactly 2 \*\*shots\*\*/, 'storybook director names the shot count');
assert.match(storybookPrompt, /at most 3 of the\s+8\s+scenes `animate`/, 'storybook director states the animation cap');
assert.ok(storybookDirector.placeholders.includes('animationCap') && storybookDirector.placeholders.includes('shotsPerScene'));
const sceneDirector = skills.find((skill) => skill.name === 'cloud-lesson-scene-director')!;
assert.ok(!/shots|storybook|engraving/i.test(sceneDirector.template), 'the existing scene director must not mention storybook');
const storybookChecker = skills.find((skill) => skill.name === 'cloud-lesson-storybook-checker')!;
assert.match(storybookChecker.template, /matchesStyle/);

console.log('cloud lesson skills: all checks passed');
