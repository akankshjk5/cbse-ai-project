/**
 * End-to-end smoke test: a real deck, built by the real pipeline, then rendered
 * by the real web renderer.
 *
 * Every other test here covers one half. This one is the only thing that proves
 * the halves agree — that what `SlideCanvas` draws is the deck the builder put
 * in the .pptx, from the same specs, with the same theme.
 *
 * Makes real model calls (research, plan, style, design, images, fonts, QA) and
 * costs a few cents. It writes three things to a temp directory and prints
 * their paths: the .pptx, the generated images, and `preview.html` — open that
 * to see the deck as the app renders it.
 *
 *   npm run smoke:deck
 */

import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';

import { Manager } from '../Agents/manager.ts';
import { withTelemetry, type AgentRunRecord } from '../Agents/telemetry.ts';
import { themeFromStyleSpec } from '../Agents/pptx/theme.ts';
import type { SlideSpec, StyleSpec } from '../Agents/types.ts';
import { SlideCanvas } from '../src/components/slides/slide-canvas.tsx';
import type { SlideBlock } from '../src/lib/slides/blocks.ts';

const REQUEST = [
  'Create a science presentation on: The water cycle',
  'Audience: Class 6 students following the CBSE syllabus.',
  'Language: English.',
  'Target length: 6 slides.',
  'Pitch the depth and vocabulary at that class level — not a university lecture,',
  'and not a picture book.',
].join('\n');

/**
 * A style reference, drawn rather than downloaded.
 *
 * The pipeline requires one and refuses to guess an aesthetic, so the test has
 * to supply something with a real palette and a real type hierarchy for the
 * analyzer to read. An SVG is the cheapest way to make an image whose intended
 * design is unambiguous.
 */
async function makeReferenceImage(dir: string): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <rect width="1600" height="900" fill="#0F1E2E"/>
    <rect x="96" y="96" width="120" height="8" fill="#E8A33D"/>
    <text x="96" y="260" font-family="Georgia, serif" font-size="92" font-weight="700"
          fill="#F5F7FA">Coastal Systems</text>
    <text x="96" y="340" font-family="Helvetica, Arial, sans-serif" font-size="38"
          fill="#9FB3C8">An introduction to tidal zones</text>
    <rect x="96" y="430" width="640" height="300" rx="18" fill="#17293C"/>
    <text x="136" y="500" font-family="Helvetica, Arial, sans-serif" font-size="30"
          fill="#F5F7FA">Sediment transport</text>
    <text x="136" y="556" font-family="Helvetica, Arial, sans-serif" font-size="26"
          fill="#9FB3C8">Longshore drift moves material</text>
    <text x="136" y="600" font-family="Helvetica, Arial, sans-serif" font-size="26"
          fill="#9FB3C8">along the shoreline over time.</text>
    <rect x="800" y="430" width="704" height="300" rx="18" fill="#E8A33D"/>
    <text x="840" y="600" font-family="Georgia, serif" font-size="96" font-weight="700"
          fill="#0F1E2E">71%</text>
  </svg>`;

  const file = path.join(dir, 'reference.png');
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

/** Local build paths → `data:` URLs, so the preview works with no server. */
async function inlineImages(slideSpecs: SlideSpec[]): Promise<Map<string, string>> {
  const paths = new Set<string>();
  for (const slide of slideSpecs) {
    if (slide.background?.imagePath) paths.add(slide.background.imagePath);
    for (const element of slide.elements) {
      if (element.imagePath) paths.add(element.imagePath);
    }
  }

  const urls = new Map<string, string>();
  for (const file of paths) {
    try {
      urls.set(file, `data:image/png;base64,${(await readFile(file)).toString('base64')}`);
    } catch {
      /* a picture that failed to generate simply is not there */
    }
  }
  return urls;
}

/**
 * The same transformation `replaceSlides` performs on the way into Postgres:
 * elements become blocks, and `imagePath` becomes a URL a browser can load.
 */
function toBlocks(slide: SlideSpec, urls: Map<string, string>): SlideBlock[] {
  return slide.elements.map((element) => ({
    type: element.type,
    role: element.role,
    box: element.box,
    text: element.text,
    items: element.items,
    imagePrompt: element.imagePrompt,
    imageUrl: element.imagePath ? (urls.get(element.imagePath) ?? null) : null,
  }));
}

async function renderPreview(
  slideSpecs: SlideSpec[],
  styleSpec: StyleSpec,
  outFile: string,
): Promise<void> {
  const theme = themeFromStyleSpec(styleSpec);
  const urls = await inlineImages(slideSpecs);
  const slideSize = { width: styleSpec.slideSize.width, height: styleSpec.slideSize.height };

  const families = [theme.fonts.heading, theme.fonts.body]
    .filter((family, index, all) => all.indexOf(family) === index)
    .map((family) => `family=${family.replace(/ /g, '+')}:wght@400;700`)
    .join('&');

  const body = slideSpecs
    .slice()
    .sort((a, b) => a.slideNumber - b.slideNumber)
    .map((slide) => {
      const markup = renderToStaticMarkup(
        SlideCanvas({
          slide: {
            title: slide.title ?? null,
            subtitle: slide.subtitle ?? null,
            blocks: toBlocks(slide, urls),
            backgroundUrl: slide.background?.imagePath
              ? (urls.get(slide.background.imagePath) ?? null)
              : null,
            backgroundDim: slide.background?.dim ?? 0.35,
          },
          theme,
          slideSize,
        }),
      );

      return `<figure><figcaption>${slide.slideNumber}. ${
        slide.title ?? '(untitled)'
      }</figcaption>${markup}</figure>`;
    })
    .join('\n');

  await writeFile(
    outFile,
    `<!doctype html><meta charset="utf-8"><title>Deck preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=swap">
<style>
  body { margin: 0; padding: 32px; background: #e9edf2; font: 14px system-ui, sans-serif; }
  figure { margin: 0 auto 28px; max-width: 1100px; }
  figcaption { margin-bottom: 6px; color: #475569; font-size: 12px; }
  figure > div { box-shadow: 0 6px 24px rgba(15,23,42,.18); border-radius: 6px; }
</style>
${body}
`,
    'utf8',
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

const workDir = await mkdtemp(path.join(tmpdir(), 'lumina-smoke-'));
const imagePath = await makeReferenceImage(workDir);
console.log(`reference: ${imagePath}\n`);

let cost = 0;
let calls = 0;

const manager = new Manager({
  userRequest: REQUEST,
  styleReference: { imagePath },
  imageDir: path.join(workDir, 'images'),
  runId: 'smoke-deck',
  targetSlideCount: 6,
  onLog: (entry) => {
    if (entry.type === 'reasoning') {
      const stage = typeof entry.metadata?.of === 'string' ? entry.metadata.of : 'model';
      const text = entry.message.split(/\r?\n/).join(' ');
      console.log(`  ~ ${stage}: ${text.slice(0, 150)}`);
      return;
    }
    const icon = { step: '·', result: '✓', error: '✗', handoff: '→' }[
      entry.type as 'step' | 'result' | 'error' | 'handoff'
    ];
    const detail = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
    console.log(`${icon} ${entry.message}${detail}`);
  },
});

const describe = (record: AgentRunRecord) => {
  const tokens = (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
  return `${record.agent} · ${record.model} · ${tokens} tok · $${(record.costUsd ?? 0).toFixed(5)} · ${(
    record.latencyMs / 1000
  ).toFixed(1)}s${record.error ? ` — ${record.error.slice(0, 80)}` : ''}`;
};

const result = await withTelemetry((record) => {
  calls += 1;
  cost += record.costUsd ?? 0;
  console.log(`  ${record.status === 'failed' ? '✗' : '$'} ${describe(record)}`);
}, () => manager.run());

manager.dispose();

console.log(`\n${'─'.repeat(70)}`);
console.log(`model calls: ${calls}   total cost: $${cost.toFixed(4)}`);

if (!result.success || !result.artifacts) {
  console.error(`FAILED (${result.error?.code}): ${result.error?.message}`);
  process.exit(1);
}

const { pptxPath, styleSpec, slideSpecs, imagePaths } = result.artifacts;

console.log(`slides:      ${slideSpecs.length}`);
console.log(`images:      ${imagePaths.length}`);
console.log(`fonts:       ${styleSpec.typography.headingFont} / ${styleSpec.typography.bodyFont}`);
console.log(`palette:     ${Object.values(styleSpec.colors).filter(Boolean).join(' ')}`);
console.log(`pptx:        ${pptxPath}`);

const preview = path.join(workDir, 'preview.html');
await renderPreview(slideSpecs, styleSpec, preview);
console.log(`preview:     ${preview}`);

const qa = result.qa;
if (qa) {
  console.log(
    `qa:          passed=${qa.passed} critical=${
      qa.issues.filter((i) => i.severity === 'critical').length
    } major=${qa.issues.filter((i) => i.severity === 'major').length}`,
  );
  for (const issue of qa.issues.slice(0, 6)) {
    console.log(`             [${issue.severity}] ${issue.description}`);
  }
}

console.log('\nOK');
