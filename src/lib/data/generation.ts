import 'server-only';

import type { AgentRunRecord } from '@agents/telemetry';
import type { SlideSpec, StyleSpec } from '@agents/types';
import { progressForStage } from '@/lib/generation/stages';
import { assertBuildQuota } from '@/lib/limits';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { GenerationJob, Json, TablesInsert } from '@/lib/supabase/types';

/**
 * Generation-job data access.
 *
 * Unlike `data/decks.ts`, most of this runs on the SERVICE-ROLE client. That is
 * not a shortcut: `generation_jobs` and `agent_runs` are read-only to
 * `authenticated` by design (migration 0400), because the worker writing them
 * outlives the request that started it and has no session of its own.
 *
 * The rule that replaces RLS here: every function below takes a Clerk `userId`
 * that the CALLER has already checked owns the deck — `startJob` re-checks it
 * on the user-scoped client before any admin write happens, and nothing else in
 * this file may be called with a deck the caller has not passed through it.
 */


/**
 * Opens a job for `deckId` and marks the deck `generating`.
 *
 * The ownership check runs on the user-scoped client — RLS refuses a deck the
 * caller does not own — and only then does the admin client write the job row.
 * Returns null if the deck is not theirs, so callers can 404 rather than leak
 * the difference between "not yours" and "does not exist".
 */
export async function startJob(
  userId: string,
  deckId: string,
  input: Record<string, unknown>,
): Promise<GenerationJob | null> {
  const userClient = await createClient();
  const { data: deck, error: deckError } = await userClient
    .from('decks')
    .select('id')
    .eq('id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (deckError) throw new Error(`startJob ownership check failed: ${deckError.message}`);
  if (!deck) return null;

  // Every build in the app opens its job here — create, approve, regenerate —
  // so this is the one place that can guarantee no path spends money without
  // asking. The actions check first so the refusal lands on the form; this is
  // what makes that a courtesy rather than the control.
  await assertBuildQuota(userId);

  const admin = createAdminClient();

  const { data: job, error } = await admin
    .from('generation_jobs')
    .insert({
      deck_id: deckId,
      owner_id: userId,
      status: 'running',
      stage: 'queued',
      progress: progressForStage('queued'),
      input: input as Json,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`startJob failed: ${error.message}`);

  await admin.from('decks').update({ status: 'generating' }).eq('id', deckId);

  return job;
}

/** Progress ping. Failures are swallowed — a lost tick must not kill a build. */
export async function reportProgress(jobId: string, stage: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('generation_jobs')
    .update({ stage, progress: progressForStage(stage) })
    .eq('id', jobId);
}

/**
 * Writes one `agent_runs` row — model, tokens, cost, latency, raw output.
 *
 * Called once per model call from the pipeline's telemetry sink. Errors are
 * swallowed by the caller: losing a telemetry row must never cost the deck.
 */
export async function recordAgentRun(
  jobId: string,
  deckId: string,
  run: AgentRunRecord,
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin.from('agent_runs').insert({
    job_id: jobId,
    deck_id: deckId,
    agent: run.agent,
    attempt: run.attempt,
    status: run.status,
    model: run.model,
    input: run.input as Json,
    output: (run.output ?? null) as Json,
    prompt_tokens: run.promptTokens ?? null,
    completion_tokens: run.completionTokens ?? null,
    // Null, not zero: "the provider reported no cost" and "this call was free"
    // are different facts, and summing the second would be a lie.
    cost_usd: run.costUsd ?? null,
    latency_ms: run.latencyMs,
    error: run.error ?? null,
    finished_at: new Date().toISOString(),
  });

  if (error) throw new Error(`recordAgentRun failed: ${error.message}`);
}

/**
 * Rolls `agent_runs` totals up onto the job row.
 *
 * Denormalised on purpose (see migration 0400) so the deck list can show cost
 * without a join over every run. Recomputed from the rows rather than
 * incremented, so a lost telemetry write cannot drift the total permanently.
 */
export async function rollUpJobTotals(jobId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: runs, error } = await admin
    .from('agent_runs')
    .select('prompt_tokens, completion_tokens, cost_usd')
    .eq('job_id', jobId);

  if (error) throw new Error(`rollUpJobTotals failed: ${error.message}`);

  const totals = (runs ?? []).reduce(
    (acc, run) => ({
      tokens: acc.tokens + (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0),
      cost: acc.cost + Number(run.cost_usd ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );

  await admin
    .from('generation_jobs')
    .update({ total_tokens: totals.tokens, total_cost_usd: totals.cost })
    .eq('id', jobId);
}

export async function failJob(jobId: string, deckId: string, message: string): Promise<void> {
  const admin = createAdminClient();

  await admin
    .from('generation_jobs')
    .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
    .eq('id', jobId);

  await admin.from('decks').update({ status: 'failed' }).eq('id', deckId);
}

/**
 * Replaces a deck's slides with the pipeline's output.
 *
 * Delete-then-insert rather than upsert: a regenerated deck can have a
 * different slide count, and `position` is unique per deck, so a partial
 * overwrite would collide with rows the new deck no longer has.
 */
export async function replaceSlides(
  deckId: string,
  slideSpecs: SlideSpec[],
  imageUrls: ImageUrlMap = {},
): Promise<void> {
  const admin = createAdminClient();

  const { error: deleteError } = await admin.from('slides').delete().eq('deck_id', deckId);
  if (deleteError) throw new Error(`replaceSlides delete failed: ${deleteError.message}`);

  const rows: TablesInsert<'slides'>[] = slideSpecs.map((slide, index) => {
    const images = slide.elements.filter((element) => element.type === 'image');

    return {
      deck_id: deckId,
      // The spec is 1-based for humans; the column is 0-based and contiguous.
      position: index,
      layout: slide.layout,
      title: slide.title ?? null,
      subtitle: slide.subtitle ?? null,
      // Elements ARE the blocks — structured content, never rendered HTML —
      // with local paths swapped for URLs on the way in.
      blocks: toWebBlocks(slide, imageUrls) as unknown as Json,
      speaker_notes: slide.speakerNotes ?? null,
      image_prompt: images[0]?.imagePrompt ?? null,
      hero_image_url: urlOf(images[0]?.imagePath, imageUrls),
      background_url: urlOf(slide.background?.imagePath, imageUrls),
      // The scrim strength the Background Designer chose. Without it the web
      // renderer would guess, and a backdrop meant to sit at 15% would come
      // back at the default 35% with the text washed out.
      metadata: slide.background ? ({ backgroundDim: slide.background.dim } as Json) : {},
    };
  });

  const { error } = await admin.from('slides').insert(rows);
  if (error) throw new Error(`replaceSlides insert failed: ${error.message}`);
}

/**
 * Local build path → public CDN URL, for every picture the build stored.
 *
 * Keyed by path rather than ordered, because a deck's images are produced by
 * two different stages — backdrops first, then illustrations — and a
 * positional array silently pairs slide 3's hero with slide 1's backdrop. The
 * path is the only identifier both halves agree on.
 */
export type ImageUrlMap = Record<string, string>;

function urlOf(imagePath: string | undefined, urls: ImageUrlMap): string | null {
  return imagePath ? (urls[imagePath] ?? null) : null;
}

/**
 * A slide's elements, ready for a browser.
 *
 * The only change is `imagePath` → `imageUrl`. The path points inside a temp
 * directory on the build machine: useless to a browser, and not something to
 * hand one. See `src/lib/slides/blocks.ts` for the shape this produces.
 */
function toWebBlocks(slide: SlideSpec, urls: ImageUrlMap): unknown[] {
  return slide.elements.map((element) => {
    if (element.type !== 'image') return element;

    const { imagePath, ...rest } = element;
    return { ...rest, imageUrl: urlOf(imagePath, urls) };
  });
}

export interface FinishJobInput {
  jobId: string;
  deckId: string;
  styleSpec: StyleSpec;
  slideSpecs: SlideSpec[];
  pptx: { bytes: Uint8Array; filename: string };
  /** Local build path → public URL, for every picture the build stored. */
  imageUrls?: ImageUrlMap;
}

/**
 * Stores everything a finished build produced, then marks deck and job done.
 *
 * Order matters: the deck only reaches `ready` once the .pptx is actually in
 * storage and the export row exists. A user who sees "ready" and finds nothing
 * to download has been lied to.
 */
export async function finishJob(input: FinishJobInput): Promise<{ exportId: string }> {
  const { jobId, deckId, styleSpec, slideSpecs, pptx, imageUrls = {} } = input;
  const admin = createAdminClient();

  await replaceSlides(deckId, slideSpecs, imageUrls);

  const { data: exportRow, error: exportError } = await admin
    .from('deck_exports')
    .insert({
      deck_id: deckId,
      owner_id: (await ownerOf(deckId)) ?? '',
      format: 'pptx',
      status: 'running',
    })
    .select()
    .single();

  if (exportError) throw new Error(`finishJob export row failed: ${exportError.message}`);

  // `<deck_id>/...` first segment — the storage policies authorise on it.
  const storagePath = `${deckId}/${exportRow.id}.pptx`;

  const { error: uploadError } = await admin.storage
    .from('deck-exports')
    .upload(storagePath, pptx.bytes, {
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      upsert: true,
    });

  if (uploadError) {
    await admin
      .from('deck_exports')
      .update({ status: 'failed', error: uploadError.message })
      .eq('id', exportRow.id);
    throw new Error(`finishJob upload failed: ${uploadError.message}`);
  }

  await admin
    .from('deck_exports')
    .update({
      status: 'succeeded',
      storage_path: storagePath,
      bytes: pptx.bytes.byteLength,
      finished_at: new Date().toISOString(),
    })
    .eq('id', exportRow.id);

  await admin
    .from('decks')
    .update({
      status: 'ready',
      slide_count: slideSpecs.length,
      style_spec: styleSpec as unknown as Json,
    })
    .eq('id', deckId);

  await admin
    .from('generation_jobs')
    .update({
      status: 'succeeded',
      stage: 'complete',
      progress: 1,
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  return { exportId: exportRow.id };
}

/** Owner of a deck, read with the admin client (the worker has no session). */
async function ownerOf(deckId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from('decks')
    .select('owner_id')
    .eq('id', deckId)
    .maybeSingle();

  return data?.owner_id ?? null;
}

/**
 * Newest job per deck, for the decks on screen, keyed by deck id.
 *
 * One query rather than one per card. Rows come back newest-first and the map
 * keeps the first sighting of each deck, so later (older) rows are ignored.
 *
 * Scoped to `deckIds` rather than to the account. Fetching the account's last
 * 200 jobs and hoping every visible deck was among them is a bet that gets
 * worse as an account gets busier: a user who rebuilt one deck twenty times
 * today would find the other cards showing no job at all, because the window
 * filled up with jobs for a deck that is not even on this page.
 */
export async function latestJobsByDeck(
  userId: string,
  deckIds: string[],
): Promise<Map<string, GenerationJob>> {
  if (deckIds.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('generation_jobs')
    .select('*')
    .eq('owner_id', userId)
    .in('deck_id', deckIds)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`latestJobsByDeck failed: ${error.message}`);

  const byDeck = new Map<string, GenerationJob>();
  for (const job of data ?? []) {
    if (!byDeck.has(job.deck_id)) byDeck.set(job.deck_id, job);
  }
  return byDeck;
}

/**
 * Every agent run for a deck, oldest first — the build's own log.
 *
 * RLS-scoped (`agent_runs: read own` keys on `is_deck_owner`), so this is one
 * of the few generation reads that needs no extra ownership check. `output` is
 * deliberately excluded: it holds whole StyleSpecs and slide sets, which is far
 * more than a activity panel needs and enough to make the query slow.
 */
export async function listAgentRuns(userId: string, deckId: string) {
  const supabase = await createClient();

  const { data: job } = await supabase
    .from('generation_jobs')
    .select('id')
    .eq('deck_id', deckId)
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) return [];

  const { data, error } = await supabase
    .from('agent_runs')
    .select('agent, attempt, status, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, error, created_at')
    .eq('job_id', job.id)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`listAgentRuns failed: ${error.message}`);
  return data ?? [];
}

/** The newest job for a deck the caller owns. RLS-scoped: read-only is enough. */
export async function latestJob(userId: string, deckId: string): Promise<GenerationJob | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('generation_jobs')
    .select('*')
    .eq('deck_id', deckId)
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`latestJob failed: ${error.message}`);
  return data;
}

/**
 * A time-limited download URL for a deck's most recent .pptx export.
 *
 * Signed rather than public: `deck-exports` is a private bucket, and a rendered
 * deck is the user's work. Null when the deck has no successful export yet.
 */
export async function latestExportUrl(userId: string, deckId: string): Promise<string | null> {
  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from('deck_exports')
    .select('storage_path')
    .eq('deck_id', deckId)
    .eq('owner_id', userId)
    .eq('status', 'succeeded')
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`latestExportUrl failed: ${error.message}`);
  if (!row?.storage_path) return null;

  const { data: signed, error: signError } = await supabase.storage
    .from('deck-exports')
    .createSignedUrl(row.storage_path, 60 * 10);

  if (signError) throw new Error(`latestExportUrl signing failed: ${signError.message}`);
  return signed?.signedUrl ?? null;
}
