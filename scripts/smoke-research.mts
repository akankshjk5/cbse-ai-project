/**
 * Smoke test for the reasoning half of the pipeline: the Researcher (with live
 * web search), the Content Planner's word budgets, and the JSON image prompt.
 *
 * Makes real model calls, so it needs OPENROUTER_API_KEY and costs a few
 * cents. It exists because the three things it covers are the ones that cannot
 * be verified by types: whether reasoning actually streams back, whether the
 * search plugin is accepted by the provider, and whether the locked style
 * block comes out of `styleEnvelope` byte-identical across subjects.
 *
 *   npm run smoke:research
 */

import { generateStructured } from '../Agents/Agent.ts';
import { buildImagePrompt, styleEnvelope } from '../Agents/image-prompt.ts';
import { MEMORY_KEYS, openMemory, disposeMemory, liveMemoryCount } from '../Agents/memory.ts';
import { withReasoning } from '../Agents/reasoning.ts';
import { loadSkill } from '../Agents/skill-loader.ts';
import {
  contentPlanSchema,
  researchBriefSchema,
  styleSpecSchema,
} from '../Agents/types.ts';

const TOPIC =
  'Create a Class 8 science presentation on photosynthesis for CBSE students. Target length: 8 slides.';

const runId = 'smoke-research';
const memory = openMemory(runId, (entry) => {
  if (entry.type === 'reasoning') {
    const stage = typeof entry.metadata?.of === 'string' ? entry.metadata.of : 'model';
    console.log(`  ~ ${stage}: ${entry.message.split(/\r?\n/).join(' ').slice(0, 160)}`);
    return;
  }
  const detail = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
  console.log(`  ${entry.type === 'error' ? '✗' : '·'} ${entry.message}${detail}`);
});

let reasoningBursts = 0;

await withReasoning(
  (_stage, delta) => {
    reasoningBursts += 1;
    memory.reasoning(_stage, delta);
  },
  async () => {
    // ── Research, with live web search ────────────────────────────────────────
    console.log('\n── researcher (web search attached) ──');
    const researcher = await loadSkill('researcher');

    const brief = await generateStructured({
      systemPrompt: researcher.systemPrompt,
      model: researcher.model,
      userPrompt: [
        `Request: ${TOPIC}`,
        'No documents were supplied. Live web results are attached to this call.',
        'Return a ResearchBrief as JSON.',
      ].join('\n\n'),
      schema: researchBriefSchema,
      stage: 'researcher',
      effort: 'high',
      search: { searchPrompt: TOPIC },
    });

    console.log(`  findings: ${brief.findings.length}`);
    console.log(`  sources:  ${brief.sources.map((s) => s.kind).join(', ') || '(none listed)'}`);
    console.log(`  open:     ${brief.openQuestions.length}`);
    if (brief.findings.length === 0) throw new Error('researcher returned no findings');

    memory.note(MEMORY_KEYS.research, {
      summary: brief.summary,
      findings: brief.findings.length,
    });

    // ── Outline, with word budgets ────────────────────────────────────────────
    console.log('\n── content-planner (word budgets) ──');
    const planner = await loadSkill('content-planner');

    const plan = await generateStructured({
      systemPrompt: planner.systemPrompt,
      model: planner.model,
      userPrompt: [
        memory.digest([MEMORY_KEYS.research]),
        `Request: ${TOPIC}`,
        `ResearchBrief: ${JSON.stringify(brief)}`,
        'Return a ContentPlan as JSON.',
      ].join('\n\n'),
      schema: contentPlanSchema,
      stage: 'content-planner',
    });

    console.log(`  ceiling: ${plan.maxWordsPerSlide} words/slide`);
    for (const slide of plan.slides) {
      console.log(
        `  ${String(slide.number).padStart(2)}. [${slide.section.padEnd(10)}] ${slide.wordBudget
          .toString()
          .padStart(3)}w  ${slide.keyMessage.slice(0, 64)}`,
      );
    }

    const sections = new Set(plan.slides.map((s) => s.section));
    console.log(`  opens: ${sections.has('intro')}  closes: ${sections.has('conclusion')}`);
  },
);

// ── The locked style block ──────────────────────────────────────────────────
console.log('\n── image prompt (style locked, subject varies) ──');

const styleSpec = styleSpecSchema.parse({
  version: '1',
  source: { type: 'image', path: 'ref.png' },
  slideSize: { width: 13.333, height: 7.5, aspectRatio: '16:9' },
  colors: { background: '#0B1B2B', primaryText: '#FFFFFF', accent: '#F2A65A' },
  typography: {
    headingFont: 'Georgia',
    bodyFont: 'Arial',
    title: { size: 40, weight: 700 },
    body: { size: 18, weight: 400 },
  },
  spacing: { outerMargin: 0.6, sectionGap: 0.4, elementGap: 0.3, paragraphGap: 0.15 },
  visualLanguage: 'flat editorial illustration, soft geometric shapes, no gradients',
  layoutPrinciples: ['generous whitespace', 'strong type hierarchy'],
});

const style = styleEnvelope(styleSpec);
const output = { width: 1280, height: 1440, aspectRatio: '8:9' };

const a = buildImagePrompt({ style, subject: { description: 'a leaf cross-section' }, output });
const b = buildImagePrompt({ style, subject: { description: 'the sun over a field' }, output });

const styleBlockOf = (prompt: string) =>
  JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)).style);

const locked = styleBlockOf(a) === styleBlockOf(b);
console.log(`  style block identical across subjects: ${locked}`);
console.log(`  palette in prompt: ${Object.keys(style.palette).join(', ')}`);
if (!locked) throw new Error('style block drifted between subjects');

// ── Memory disposal ─────────────────────────────────────────────────────────
console.log('\n── working memory ──');
console.log(`  entries before dispose: ${memory.all().length}`);
console.log(`  live runs: ${liveMemoryCount()}`);
disposeMemory(runId);
console.log(`  live runs after dispose: ${liveMemoryCount()}`);
if (liveMemoryCount() !== 0) throw new Error('memory was not disposed');

console.log(`\nreasoning bursts captured: ${reasoningBursts}`);
if (reasoningBursts === 0) {
  console.log('WARNING: no reasoning streamed back — check OPENROUTER_REASONING_EFFORT');
}

console.log('\nOK');
