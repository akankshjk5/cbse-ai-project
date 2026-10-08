import 'server-only';

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Manager } from '@agents/manager';
import { withTelemetry, type AgentRunRecord } from '@agents/telemetry';
import { styleSpecSchema, type ContentPlan, type ResearchBrief, type StyleSpec } from '@agents/types';
import { clearDraft, saveDraft } from '@/lib/data/drafts';
import {
  failJob,
  finishJob,
  recordAgentRun,
  reportProgress,
  rollUpJobTotals,
  type ImageUrlMap,
} from '@/lib/data/generation';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Deck } from '@/lib/supabase/types';

/**
 * The bridge between the app and the agent pipeline.
 *
 * The Manager is filesystem-shaped — it wants a local path for the style
 * reference and writes a .pptx to local disk — while the app is
 * Supabase-shaped. This module is the only place those two meet: it stages the
 * reference image into a temp dir, runs the build, and puts the results back
 * into Postgres and Storage.
 *
 * It runs AFTER the response, via `after()` in the caller, so a build that
 * takes minutes does not hold a request open. That means it cannot report
 * failures to the caller — every exit path has to land in `generation_jobs`,
 * which is what the UI watches over Realtime.
 */

/** The deck fields the pipeline actually reads. */
type DeckRequest = Pick<
  Deck,
  | 'id'
  | 'title'
  | 'topic'
  | 'subject'
  | 'board'
  | 'grade_level'
  | 'language'
  | 'requested_slide_count'
  | 'source_prompt'
>;

/** Extensions `read_document` can actually extract text from. */
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
]);

/** More than this and the research prompt is mostly documents. */
const MAX_SOURCE_DOCUMENTS = 8;

/**
 * Source material for the Researcher to work from.
 *
 * `Documents/` is the repo's drop folder for source texts — NCERT chapters and
 * the like (see its README). Files there are the *primary* evidence for a
 * build; with none, the Researcher searches the web instead.
 *
 * It is deliberately per-install rather than per-deck, because there is no
 * per-deck document upload yet: `asset_kind` has no `source` member and the
 * create-deck form only takes a style reference. When that path exists this
 * function grows a Supabase branch and the folder stays as the local
 * convenience it already is. Relevance is the Researcher's problem — it is
 * given the topic and told to name what a document does not cover.
 */
async function listSourceDocuments(): Promise<string[]> {
  const folder = path.join(process.cwd(), 'Documents');

  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.toLowerCase() !== 'readme.md')
    .filter((name) => DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .slice(0, MAX_SOURCE_DOCUMENTS)
    .map((name) => path.join(folder, name));
}

/** Turns the form's structured fields back into a brief the Manager can read. */
function briefFor(deck: DeckRequest): string {
  const audience =
    deck.grade_level !== null
      ? `Class ${deck.grade_level} students following the ${deck.board} syllabus`
      : `students following the ${deck.board} syllabus`;

  return [
    `Create a ${deck.subject ?? 'classroom'} presentation on: ${deck.topic ?? deck.title}`,
    `Audience: ${audience}.`,
    `Language: ${deck.language}.`,
    deck.requested_slide_count
      ? `Target length: ${deck.requested_slide_count} slides.`
      : 'Target length: choose what the topic needs.',
    'Pitch the depth and vocabulary at that class level — not a university lecture,',
    'and not a picture book.',
  ].join('\n');
}

/**
 * Downloads the deck's style reference into a temp file the Manager can read.
 *
 * Returns null when the deck has no reference. That is not an error here — it
 * is the Manager's call to make, and it throws a clear STYLE_REFERENCE_MISSING
 * that lands in the job row.
 */
async function stageReferenceImage(deckId: string, dir: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data: asset } = await admin
    .from('deck_assets')
    .select('bucket, storage_path')
    .eq('deck_id', deckId)
    .eq('kind', 'upload')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!asset?.storage_path) return null;

  const { data: blob, error } = await admin.storage
    .from(asset.bucket)
    .download(asset.storage_path);

  if (error || !blob) {
    throw new Error(`Could not download style reference: ${error?.message ?? 'empty response'}`);
  }

  const localPath = path.join(dir, path.basename(asset.storage_path));
  await writeFile(localPath, Buffer.from(await blob.arrayBuffer()));
  return localPath;
}

/**
 * The deck's design system, when it came from a template rather than a picture.
 *
 * `createDeckAction` writes the chosen template's full StyleSpec to
 * `decks.style_spec`, so by the time a build runs the answer is already in the
 * row and the style-analyzer stage has nothing to work out. Parsed back through
 * the same Zod schema that validated it on the way in, because `jsonb` does not
 * preserve the shape it was handed.
 *
 * Returns null for a deck built from a reference image — including one that has
 * already been built once, whose `style_spec` is the *analyzed* spec and must
 * be re-derived rather than replayed, so that regenerating after swapping the
 * reference image actually changes the deck.
 */
function templateSpecFrom(styleSpec: unknown): StyleSpec | null {
  const parsed = styleSpecSchema.safeParse(styleSpec);
  if (!parsed.success) return null;
  return parsed.data.source.type === 'template' ? parsed.data : null;
}

/**
 * Prefixes that survive a terminal with no colour.
 *
 * `~` is the model thinking and `→` is one specialist handing to the next —
 * between them they are most of what you want when a build produced a deck
 * that is technically valid and obviously wrong.
 */
const ICONS = {
  step: '·',
  result: '✓',
  error: '✗',
  reasoning: '~',
  handoff: '→',
} as const;

/**
 * Reasoning is multi-line and long. Indented under its stage and hard-wrapped
 * so it reads as a block rather than smearing across an 80-column terminal.
 */
function formatReasoning(tag: string, stage: string, text: string): string {
  const head = `${tag} ${ICONS.reasoning} ${stage}`;
  const body = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${tag}     ${line}`)
    .join('\n');

  return `${head}\n${body}`;
}

/** One line per model call: what ran, on what, for how much. */
function describeRun(record: AgentRunRecord): string {
  const tokens = (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
  const parts = [
    record.agent,
    record.attempt > 0 ? `retry ${record.attempt}` : null,
    record.model,
    tokens > 0 ? `${tokens} tok` : null,
    record.costUsd !== undefined ? `$${record.costUsd.toFixed(4)}` : null,
    `${(record.latencyMs / 1000).toFixed(1)}s`,
    record.error ? `— ${record.error.split(/\r?\n/)[0].slice(0, 120)}` : null,
  ].filter(Boolean);

  return parts.join(' · ');
}

/**
 * Uploads the generated illustrations and records them as deck assets.
 *
 * `deck-assets` is the public bucket — these are generated art, already
 * embedded in a .pptx the user can hand out, so a CDN URL is the point. Failure
 * is logged and swallowed: the deck itself is already built, and losing the
 * web copy of an image is not worth failing a finished build over.
 */
async function storeDeckImages(deckId: string, imagePaths: string[]): Promise<ImageUrlMap> {
  if (imagePaths.length === 0) return {};

  const admin = createAdminClient();
  const urls: ImageUrlMap = {};

  for (const imagePath of imagePaths) {
    try {
      // `<deck_id>/...` first segment — the storage policies authorise on it.
      const storagePath = `${deckId}/${path.basename(imagePath)}`;
      const bytes = await readFile(imagePath);

      const { error } = await admin.storage
        .from('deck-assets')
        .upload(storagePath, bytes, { contentType: 'image/png', upsert: true });

      if (error) throw new Error(error.message);

      await admin.from('deck_assets').insert({
        deck_id: deckId,
        // `hero` is the closest of the asset_kind enum: a generated
        // illustration placed on a slide. `source` records how it was made.
        kind: 'hero',
        source: 'generated',
        bucket: 'deck-assets',
        storage_path: storagePath,
      });

      // Keyed by the path the SlideSpec still refers to, so the slide rows can
      // pair each picture with the element that asked for it.
      urls[imagePath] = admin.storage.from('deck-assets').getPublicUrl(storagePath).data.publicUrl;
    } catch (error) {
      console.error(
        `[generation] ${deckId}: could not store ${path.basename(imagePath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return urls;
}

/**
 * Everything both phases need: the deck, a temp dir, and a wired Manager.
 *
 * The draft phase and the build phase construct the Manager identically — same
 * brief, same reference image, same logging — and a difference between them
 * would mean the deck a user approved is not the deck that gets built. One
 * function, called twice.
 */
async function openRun(
  userId: string,
  deckId: string,
  jobId: string,
): Promise<
  | { ok: true; deck: DeckRequest; manager: Manager; workDir: string; tag: string }
  | { ok: false; message: string }
> {
  const admin = createAdminClient();

  const { data: row, error } = await admin
    .from('decks')
    .select(
      'id, title, topic, subject, board, grade_level, language, requested_slide_count, source_prompt, style_spec',
    )
    .eq('id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (error || !row) {
    return { ok: false, message: error?.message ?? `Deck ${deckId} not found for this user` };
  }

  const { style_spec: styleSpec, ...deck } = row;
  const tag = `[deck ${deckId.slice(0, 8)}]`;
  const workDir = await mkdtemp(path.join(tmpdir(), `lumina-${deckId}-`));
  const imagePath = await stageReferenceImage(deckId, workDir);
  const sourceFiles = await listSourceDocuments();

  const manager = new Manager(
    {
      userRequest: briefFor(deck),
      styleReference: imagePath ? { imagePath } : undefined,
      stylePreset: templateSpecFrom(styleSpec) ?? undefined,
      sourceFiles,
      targetSlideCount: deck.requested_slide_count ?? undefined,
      imageDir: path.join(workDir, 'images'),
      runId: jobId,
      onLog: (entry) => {
        if (entry.type === 'reasoning') {
          const stage = typeof entry.metadata?.of === 'string' ? entry.metadata.of : 'model';
          console.log(formatReasoning(tag, stage, entry.message));
          return;
        }

        const detail = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
        const line = `${tag} ${ICONS[entry.type]} ${entry.message}${detail}`;
        if (entry.type === 'error') console.warn(line);
        else console.log(line);
      },
    },
    (status) => {
      void reportProgress(jobId, status).catch(() => {});
    },
  );

  return { ok: true, deck, manager, workDir, tag };
}

/** Records every model call to `agent_runs` and to the terminal. */
function telemetrySink(tag: string, jobId: string, deckId: string) {
  return (record: AgentRunRecord) => {
    console.log(
      `${tag} ${ICONS[record.status === 'failed' ? 'error' : 'result']} ${describeRun(record)}`,
    );
    return recordAgentRun(jobId, deckId, record).catch(() => {});
  };
}

/**
 * Researches and outlines a deck, then stops for review.
 *
 * The expensive half of a build — style, writing, illustration — is deferred
 * until a person has looked at the plan and said yes. Research and planning
 * cost about a cent; what follows costs twenty to thirty times that, so the
 * pause pays for itself the first time someone wanted a different deck.
 *
 * Never throws, for the same reason `runDeckGeneration` does not: it is a
 * fire-and-forget `after()` callback with nobody left to catch it.
 */
export async function runDeckDraft(
  userId: string,
  deckId: string,
  jobId: string,
): Promise<void> {
  const tag = `[deck ${deckId.slice(0, 8)}]`;
  let workDir: string | null = null;
  let manager: Manager | null = null;

  try {
    const run = await openRun(userId, deckId, jobId);
    if (!run.ok) {
      console.error(`[generation] ${deckId}: ${run.message}`);
      await failJob(jobId, deckId, run.message).catch(() => {});
      return;
    }

    workDir = run.workDir;
    manager = run.manager;
    console.log(`${tag} ▶ drafting ${run.deck.title}`);

    const result = await withTelemetry(telemetrySink(tag, jobId, deckId), () =>
      run.manager.draft(),
    );

    await rollUpJobTotals(jobId).catch(() => {});

    if (!result.success || !result.plan || !result.research) {
      const message = result.error?.message ?? 'Could not draft an outline';
      console.error(`[generation] ${deckId} draft failed: ${message}`);
      await failJob(jobId, deckId, message);
      return;
    }

    await saveDraft(deckId, userId, { research: result.research, plan: result.plan });
    console.log(`${tag} ✓ outline ready for review (${result.plan.slides.length} slides)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generation] ${deckId} draft threw: ${message}`);
    await rollUpJobTotals(jobId).catch(() => {});
    await failJob(jobId, deckId, message).catch(() => {});
  } finally {
    // The working memory is NOT disposed here: the run is paused, not over, and
    // the build phase re-opens it under the same job id.
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    manager?.dispose();
  }
}

/**
 * Builds a deck from an outline its owner has approved.
 *
 * Skips research and planning — they happened before the review, and their
 * results are handed in rather than paid for twice.
 */
export async function runApprovedBuild(
  userId: string,
  deckId: string,
  jobId: string,
  approved: { plan: ContentPlan; research: ResearchBrief | null },
): Promise<void> {
  const tag = `[deck ${deckId.slice(0, 8)}]`;
  let workDir: string | null = null;
  let manager: Manager | null = null;

  try {
    const run = await openRun(userId, deckId, jobId);
    if (!run.ok) {
      console.error(`[generation] ${deckId}: ${run.message}`);
      await failJob(jobId, deckId, run.message).catch(() => {});
      return;
    }

    workDir = run.workDir;
    manager = run.manager;
    console.log(`${tag} ▶ building ${run.deck.title} (approved outline)`);

    const result = await withTelemetry(telemetrySink(tag, jobId, deckId), () =>
      run.manager.buildApproved(approved.plan, approved.research ?? undefined),
    );

    await rollUpJobTotals(jobId).catch(() => {});
    await storeResult(userId, deckId, jobId, run.deck, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generation] ${deckId} build threw: ${message}`);
    await rollUpJobTotals(jobId).catch(() => {});
    await failJob(jobId, deckId, message).catch(() => {});
  } finally {
    manager?.dispose();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Puts a finished build into Postgres and Storage, or records why it failed.
 *
 * Shared by the reviewed and unattended paths so a deck built either way lands
 * identically — same assets, same export row, same terminal state.
 */
async function storeResult(
  userId: string,
  deckId: string,
  jobId: string,
  deck: DeckRequest,
  result: Awaited<ReturnType<Manager['run']>>,
): Promise<void> {
  if (!result.success || !result.artifacts) {
    const message = result.error?.message ?? 'Generation failed';
    console.error(`[generation] ${deckId} failed in ${result.error?.code ?? 'unknown'}: ${message}`);
    await failJob(jobId, deckId, message);
    return;
  }

  const bytes = await readFile(result.artifacts.pptxPath);

  // Before the deck is marked ready: the .pptx has the images embedded, but the
  // web renderer and any future re-edit need them as assets too.
  const assetUrls = await storeDeckImages(deckId, result.artifacts.imagePaths);

  await finishJob({
    jobId,
    deckId,
    styleSpec: result.artifacts.styleSpec,
    slideSpecs: result.artifacts.slideSpecs,
    imageUrls: assetUrls,
    pptx: {
      bytes,
      filename: result.presentation?.filename ?? `${deck.title}.pptx`,
    },
  });

  // The outline has become slides; an editable copy of it beside a finished
  // deck would only invite changes that cannot take effect.
  await clearDraft(deckId).catch(() => {});
  void userId;
}

/**
 * Builds a deck end to end, for a job that has ALREADY been opened.
 *
 * The job row is created by the caller, inside the request, for two reasons.
 * It needs the Clerk-scoped client to check ownership, and `after()` runs once
 * the response is gone — and, more importantly, it means a failure to even
 * start is reported to the user's form instead of vanishing. By the time this
 * runs there is a row to write the outcome to no matter what happens.
 *
 * Never throws: the caller is a fire-and-forget `after()` callback with nobody
 * left to catch it, so every failure is recorded on the job row instead. It is
 * also logged, because a `generating` card that never moves is otherwise
 * invisible in the dev terminal.
 */
export async function runDeckGeneration(
  userId: string,
  deckId: string,
  jobId: string,
): Promise<void> {
  const admin = createAdminClient();

  const { data: row, error: deckError } = await admin
    .from('decks')
    .select(
      'id, title, topic, subject, board, grade_level, language, requested_slide_count, source_prompt, style_spec',
    )
    .eq('id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (deckError || !row) {
    const message = deckError?.message ?? `Deck ${deckId} not found for this user`;
    console.error(`[generation] ${deckId}: ${message}`);
    await failJob(jobId, deckId, message).catch(() => {});
    return;
  }

  const { style_spec: deckStyleSpec, ...deck } = row;

  const job = { id: jobId };
  // Short id: enough to follow one build through an interleaved dev log.
  const tag = `[deck ${deckId.slice(0, 8)}]`;
  let workDir: string | null = null;
  let manager: Manager | null = null;

  console.log(`${tag} ▶ ${deck.title}`);

  try {
    workDir = await mkdtemp(path.join(tmpdir(), `lumina-${deckId}-`));
    const imagePath = await stageReferenceImage(deckId, workDir);
    const sourceFiles = await listSourceDocuments();

    const build = new Manager(
      {
        userRequest: briefFor(deck),
        styleReference: imagePath ? { imagePath } : undefined,
        stylePreset: templateSpecFrom(deckStyleSpec) ?? undefined,
        sourceFiles,
        targetSlideCount: deck.requested_slide_count ?? undefined,
        // Illustrations land in the same temp dir, so the `finally` below is
        // the only cleanup either of them needs.
        imageDir: path.join(workDir, 'images'),
        // The job id keys the run's working memory, so it can be found — and
        // disposed of — from outside the Manager.
        runId: jobId,
        onLog: (entry) => {
          if (entry.type === 'reasoning') {
            const stage = typeof entry.metadata?.of === 'string' ? entry.metadata.of : 'model';
            console.log(formatReasoning(tag, stage, entry.message));
            return;
          }

          const detail = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
          const line = `${tag} ${ICONS[entry.type]} ${entry.message}${detail}`;
          if (entry.type === 'error') console.warn(line);
          else console.log(line);
        },
      },
      // Progress ticks are best-effort. A dropped one costs a stale progress
      // bar; a thrown one would cost the whole deck.
      (status) => {
        void reportProgress(job.id, status).catch(() => {});
      },
    );

    // Held outside the try so the `finally` can drop its working memory even
    // when the build throws partway through.
    manager = build;

    // Every model call inside run() lands in agent_runs AND in the terminal. A
    // telemetry write that fails is swallowed — the deck matters more than the
    // row — but the console line is emitted either way.
    const result = await withTelemetry((record) => {
      console.log(`${tag} ${ICONS[record.status === 'failed' ? 'error' : 'result']} ${describeRun(record)}`);
      return recordAgentRun(job.id, deckId, record).catch(() => {});
    }, () => build.run());

    await rollUpJobTotals(job.id).catch(() => {});

    if (!result.success || !result.artifacts) {
      const message = result.error?.message ?? 'Generation failed';
      console.error(`[generation] ${deckId} failed in ${result.error?.code ?? 'unknown'}: ${message}`);
      await failJob(job.id, deckId, message);
      return;
    }

    const bytes = await readFile(result.artifacts.pptxPath);

    // Before the deck is marked ready: the .pptx has the images embedded, but
    // the web renderer and any future re-edit need them as assets too.
    const assetUrls = await storeDeckImages(deckId, result.artifacts.imagePaths);

    await finishJob({
      jobId: job.id,
      deckId,
      styleSpec: result.artifacts.styleSpec,
      slideSpecs: result.artifacts.slideSpecs,
      imageUrls: assetUrls,
      pptx: {
        bytes,
        filename: result.presentation?.filename ?? `${deck.title}.pptx`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Logged as well as recorded: this is the path that swallowed the build
    // silently before, leaving a card spinning with nothing in the terminal.
    console.error(`[generation] ${deckId} threw: ${message}`);
    // A build that died partway still burned tokens; roll up what it spent.
    await rollUpJobTotals(job.id).catch(() => {});
    await failJob(job.id, deckId, message).catch(() => {});
  } finally {
    // Both halves of the build's scratch space go together: the temp dir on
    // disk, and the run's working memory in the process cache. The latter
    // holds research notes, prompts and reasoning for a deck that is finished,
    // and this process outlives the request by days.
    manager?.dispose();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
