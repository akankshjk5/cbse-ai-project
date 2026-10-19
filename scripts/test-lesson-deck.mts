/**
 * A teacher's request becoming a deck, against a MOCKED planner.
 *
 * The server below speaks `/structured`, the contract in
 * `ops/runpod/local_planner_service.py`, and returns a plan this file wrote.
 * NO MODEL RUNS. Nothing here is AI-generated, and the plan is fixture content
 * dressed as a planner reply so the path after the planner can be exercised.
 *
 * What that path does prove: that a valid plan becomes an editable deck with
 * the expected structure, that a malformed one is refused before a file
 * exists, that an absent planner is an error rather than a quiet fall back to
 * the hand-written sample, and that no citation is invented anywhere.
 *
 *   npm run test:lesson-deck
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

import {
  buildLessonDeck,
  composeSlideSpecs,
  defaultStyleSpec,
  lessonDeckRequestSchema,
  lessonPlanSchema,
} from '../Agents/lesson-deck.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** A plan shaped like one a planner would return. Written here, not generated. */
const PLAN = {
  title: 'Why Ice Floats',
  subtitle: 'What happens to water when it freezes',
  objectives: [
    'Say what density means in your own words',
    'Explain what water does differently below four degrees',
  ],
  slides: [
    {
      heading: 'Density decides what floats',
      explanation:
        'Density is how much mass is packed into a given space. Put two things of '
        + 'the same size side by side and the heavier one is denser. Anything less '
        + 'dense than the liquid around it floats.',
      example: 'A cork floats because a cork-sized piece of water weighs more than it does.',
      diagram: 'two equal-sized blocks on a balance, one heavier',
    },
    {
      heading: 'Water breaks the usual rule',
      explanation:
        'Cool almost any liquid and its particles crowd together, so it gets denser. '
        + 'Water does this until about four degrees. Below that its molecules lock '
        + 'into a pattern that holds them further apart.',
      example: 'A bottle of water left in the freezer bulges, because the ice needs more room.',
      diagram: 'a six-sided lattice of water molecules, spaced apart',
    },
  ],
  summary: [
    'Less dense than the liquid around it means it floats',
    'Water expands below four degrees as it cools',
  ],
  knowledgeCheck: [
    'Two blocks are the same size. One floats, one sinks. What differs?',
    'Why does a sealed bottle of water crack in the freezer?',
  ],
};

const REQUEST = {
  classLevel: 8,
  subject: 'Science',
  topic: 'Why ice floats on water',
  language: 'en-IN' as const,
  objectives: ['Explain why ice floats', 'Describe how a pond freezes'],
  contentSlides: 2,
  illustrations: 'none' as const,
};

interface Mock { url: string; close: () => Promise<void>; calls: Record<string, unknown>[] }

async function startPlanner(reply: unknown, status = 200): Promise<Mock> {
  const calls: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push(JSON.parse(body || '{}'));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

const workDir = await mkdtemp(join(tmpdir(), 'lumina-deck-'));

// ── The request contract ───────────────────────────────────────────────────

check(lessonDeckRequestSchema.safeParse(REQUEST).success, 'a well-formed request must parse');
for (const [label, bad] of [
  ['an unsupported language', { ...REQUEST, language: 'ta-IN' }],
  ['no objectives', { ...REQUEST, objectives: [] }],
  ['a class outside 1-12', { ...REQUEST, classLevel: 13 }],
  ['one content slide', { ...REQUEST, contentSlides: 1 }],
] as const) {
  check(!lessonDeckRequestSchema.safeParse(bad).success, `${label} must be refused`);
}
console.log('request: an unsupported language, empty objectives and a bad class are refused');

// ── The plan contract ──────────────────────────────────────────────────────

check(lessonPlanSchema.safeParse(PLAN).success, 'the sample plan must satisfy the schema');
for (const [label, bad] of [
  ['prose instead of slides', { ...PLAN, slides: 'A long essay about ice' }],
  ['an empty explanation', { ...PLAN, slides: [{ ...PLAN.slides[0], explanation: 'short' }] }],
  ['a missing knowledge check', { ...PLAN, knowledgeCheck: [] }],
  ['a diagram line that is a paragraph',
    { ...PLAN, slides: [{ ...PLAN.slides[0], diagram: 'x'.repeat(260) }] }],
] as const) {
  check(!lessonPlanSchema.safeParse(bad).success, `${label} must be refused`);
}
console.log('plan: prose, stub explanations and paragraph-length diagram lines are refused');

// ── Planner unavailable is an error, never the fixture ─────────────────────

process.env.LOCAL_VIDEO_AGENT_URL = 'http://127.0.0.1:59997';
let failed: Error | null = null;
try {
  await buildLessonDeck(REQUEST, join(workDir, 'never.pptx'));
} catch (error) { failed = error as Error; }
check(failed, 'an unreachable planner must fail the build');
check(/PLANNER_UNAVAILABLE|did not answer/i.test(`${failed!.message}${(failed as { code?: string }).code ?? ''}`),
  `the error should name the planner: ${failed!.message}`);
check(!/ice floats/i.test(failed!.message), 'it must not quietly produce the fixture');
console.log('planner: an absent planner fails the build rather than serving the sample');

// ── A malformed plan is refused before a file exists ───────────────────────

let mock = await startPlanner({ output: { title: 'Only a title' }, model: 'mock-qwen' });
process.env.LOCAL_VIDEO_AGENT_URL = mock.url;
failed = null;
try {
  await buildLessonDeck(REQUEST, join(workDir, 'malformed.pptx'));
} catch (error) { failed = error as Error; }
await mock.close();
check(failed, 'a plan missing required fields must fail');
check(/did not satisfy the schema/i.test(failed!.message),
  `the error should say the schema was not met: ${failed!.message}`);
console.log('plan: a malformed planner reply is refused before any file is written');

// A plan of the wrong length is also refused: it would silently change the
// deck. Three slides is schema-valid, so this reaches the count check rather
// than stopping at the schema's own minimum of two.
mock = await startPlanner({
  output: { ...PLAN, slides: [...PLAN.slides, { ...PLAN.slides[0]!, heading: 'A third slide' }] },
  model: 'mock-qwen',
});
process.env.LOCAL_VIDEO_AGENT_URL = mock.url;
failed = null;
try {
  await buildLessonDeck(REQUEST, join(workDir, 'short.pptx'));
} catch (error) { failed = error as Error; }
await mock.close();
check(failed && /content slides/i.test(failed.message),
  `a short plan should be named as such: ${failed?.message}`);
console.log('plan: a plan with the wrong number of slides is refused');

// ── The happy path ─────────────────────────────────────────────────────────

mock = await startPlanner({ output: PLAN, model: 'qwen3-4b@mock' });
process.env.LOCAL_VIDEO_AGENT_URL = mock.url;
const out = join(workDir, 'lesson.pptx');
const result = await buildLessonDeck(REQUEST, out);

// The planner was asked in the contract's own shape.
const sent = mock.calls[0]! as Record<string, unknown>;
await mock.close();
for (const key of ['systemPrompt', 'userPrompt', 'jsonSchema', 'maxNewTokens']) {
  check(key in sent, `the planner request must carry ${key}`);
}
check(/ORIGINAL explanation/i.test(String(sent.systemPrompt)),
  'the planner must be asked for original content');
check(/do not cite a book/i.test(String(sent.systemPrompt)),
  'and told not to invent a citation');
console.log('planner: asked on /structured with the contract\'s own four fields');

// 2 content slides + title + objectives + summary + check = 6
check(result.slideCount === 6, `expected 6 slides, got ${result.slideCount}`);
check(result.contentMode === 'original_generated', 'content mode must be original_generated');
check(result.plannerModel === 'qwen3-4b@mock', `the planner model must be recorded, got ${result.plannerModel}`);
check(result.illustrated === false, 'illustrations were "none", so the deck is not illustrated');
check(result.imagesGenerated === 0, 'no image should have been requested');
console.log(`deck: ${result.slideCount} slides, provenance records ${result.plannerModel}`);

// ── The file is a real editable deck ───────────────────────────────────────

const { default: JSZip } = await import('jszip');
const { readFile } = await import('node:fs/promises');
const zip = await JSZip.loadAsync(await readFile(out));
const slideParts = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
check(slideParts.length === 6, `expected 6 slide parts, got ${slideParts.length}`);
check(zip.files['ppt/presentation.xml'], 'a real OOXML package has presentation.xml');

const xml = await Promise.all(slideParts.map((f) => zip.files[f]!.async('string')));
const body = xml.join('\n');
const runs = (body.match(/<a:t>/g) ?? []).length;
// At least two text runs per slide. A principled floor rather than a round
// number: every slide here carries a heading and a body, so anything less
// means a slide rendered empty.
check(runs >= slideParts.length * 2,
  `expected at least ${slideParts.length * 2} editable text runs, got ${runs}`);
check(body.includes('Why Ice Floats'), 'the plan title must appear as text');
check(body.includes('Check yourself'), 'the knowledge check slide must be present');
check(!/<p:pic>/.test(body), 'a text-only deck must contain no pictures');
console.log(`pptx: 6 slide parts, ${runs} editable text runs, 0 pictures`);

// Nothing fabricated anywhere in the deck.
const banned = [/\bktbs\b/i, /\bncert\b/i, /\bpage \d+/i, /approved by/i, /prescribed by/i];
const hits = banned.filter((re) => re.test(body)).map(String);
check(hits.length === 0, `fabricated citation or approval text found: ${hits.join(', ')}`);
console.log('pptx: no fabricated citation, page number or approval claim');

// ── Composition is deterministic ───────────────────────────────────────────

const request = lessonDeckRequestSchema.parse(REQUEST);
const style = defaultStyleSpec(request);
const a = composeSlideSpecs(PLAN, request, style);
const b = composeSlideSpecs(PLAN, request, style);
check(JSON.stringify(a) === JSON.stringify(b), 'the same plan must compose the same slides');
check(a.every((s, i) => s.slideNumber === i + 1), 'slide numbers must run 1..n with no gaps');
console.log('compose: the same plan produces the same slides, numbered without gaps');

// A Kannada request picks a face that can draw Kannada.
const kannada = lessonDeckRequestSchema.parse({ ...REQUEST, language: 'kn-IN' });
check(defaultStyleSpec(kannada).typography.headingFont !== 'Georgia',
  'a Kannada deck must not be set in a face with no Kannada glyphs');
console.log('language: a non-Latin deck gets a face with the right script coverage');

await rm(workDir, { recursive: true, force: true });
console.log('\nOK — planner MOCKED. No model ran and no image was generated.');
