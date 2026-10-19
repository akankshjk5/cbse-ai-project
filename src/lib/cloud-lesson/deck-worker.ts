import 'server-only';

/**
 * The worker that turns a lesson request into an editable deck.
 *
 * `requested_outputs` has accepted 'pptx' since 20261018090000 and nothing
 * built one: there was no job kind, so no worker could claim the work, and a
 * teacher who asked for a deck waited forever without ever being told it had
 * failed. `Agents/lesson-deck.ts` already builds a real deck and is tested;
 * this is the queue entry between the request and that builder.
 *
 * It does NOT re-plan the lesson. The deck builder runs the local planner
 * itself, which is the same service the video path uses. If that service is
 * absent the job fails with the planner named, rather than producing a deck
 * out of a fixture — which would be worse than failing, because a teacher
 * cannot tell generated content from filler by looking at it.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { buildLessonDeck, type LessonDeckResult } from '@agents/lesson-deck';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';

export const DECK_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const DeckJobSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  owner_id: z.string().min(1),
  kind: z.literal('deck'),
  status: z.literal('processing'),
  worker_id: z.string().min(1),
  attempts: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
});
export type DeckJob = z.infer<typeof DeckJobSchema>;

export type HeartbeatState = 'ok' | 'cancel' | 'lost';

/** What the deck builder needs, read from the lesson the teacher requested. */
export const DeckRequestSchema = z.object({
  classLevel: z.number().int().min(1).max(12),
  subject: z.string().min(2),
  topic: z.string().min(3),
  language: z.enum(['en-IN', 'hi-IN', 'kn-IN']),
  objectives: z.array(z.string().min(5)).min(1).max(6),
  contentSlides: z.number().int().min(2).max(10),
  visualStyle: z.string().min(3),
  illustrations: z.enum(['required', 'optional', 'none']),
});
export type DeckRequest = z.infer<typeof DeckRequestSchema>;

export class DeckStopped extends Error {
  constructor(readonly reason: 'cancel' | 'lost' | 'shutdown') {
    super(`Deck generation stopped: ${reason}`);
    this.name = 'DeckStopped';
  }
}

/** The database boundary, injectable so the lifecycle is testable offline. */
export interface CloudDeckStore {
  claim(workerId: string): Promise<DeckJob | null>;
  request(job: DeckJob): Promise<DeckRequest>;
  heartbeat(job: DeckJob, progress: number): Promise<HeartbeatState>;
  upload(job: DeckJob, pptx: Buffer): Promise<string>;
  complete(job: DeckJob, url: string, metadata: Record<string, unknown>): Promise<boolean>;
  fail(job: DeckJob, code: string, message: string): Promise<boolean>;
}

/**
 * How many content slides a lesson of a given length gets.
 *
 * The teacher-facing request carries a video duration, not a deck length:
 * `CreateCloudLessonSchema` has no deck-length field. Rather than invent one
 * silently, the video duration is used as a documented proxy and the mapping
 * lives here where it can be read. A deck-length field is the right fix and is
 * a schema change, not a default.
 */
export function contentSlidesFor(durationSeconds: number): number {
  return durationSeconds >= 60 ? 5 : 3;
}

/** Only called by the CLI worker, never by a page or a user-facing route. */
export function createCloudDeckStore(): CloudDeckStore {
  const client = createAdminClient();
  return {
    async claim(workerId) {
      const { data, error } = await client.rpc('claim_cloud_lesson_job', {
        p_worker_id: workerId, p_kinds: ['deck'],
      });
      if (error) throw new Error(`Could not claim deck work: ${error.message}`);
      return data?.[0] ? DeckJobSchema.parse(data[0]) : null;
    },

    async request(job) {
      // Both predicates matter: the service role bypasses RLS, so a mismatched
      // queue claim must never read another teacher's lesson.
      const { data, error } = await client.from('cloud_lesson_projects')
        .select('class_level,subject,topic,language_code,target_duration_seconds,visual_style,status,requested_outputs,learning_objective')
        .eq('id', job.project_id).eq('owner_id', job.owner_id).single();
      if (error || !data) throw new Error('Could not load this lesson request.');
      if (data.status === 'cancelled') throw new DeckStopped('cancel');
      if (!data.requested_outputs?.includes('pptx')) {
        throw new Error('This lesson did not request a deck.');
      }

      // The lesson's own objective when preparation has written one, otherwise
      // the topic. The deck schema requires at least one objective and will not
      // accept an empty list, and a planner told "no objective" writes worse
      // slides than one told the topic.
      const objective = (data.learning_objective ?? '').trim();
      const objectives = objective.length >= 5
        ? [objective]
        : [`Understand ${data.topic}`];

      return DeckRequestSchema.parse({
        classLevel: data.class_level,
        subject: data.subject,
        topic: data.topic,
        language: data.language_code,
        objectives,
        contentSlides: contentSlidesFor(data.target_duration_seconds),
        visualStyle: `${data.visual_style} educational explainer`,
        // Text-only is acceptable for a deck: a teacher can edit a slide, and
        // failing the whole deck because one picture did not render would
        // deny them something usable. The result records what was drawn.
        illustrations: 'optional',
      });
    },

    async heartbeat(job, progress) {
      const { data, error } = await client.rpc('heartbeat_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_progress: progress,
      });
      if (error) throw new Error('Could not verify deck job ownership.');
      return z.enum(['ok', 'cancel', 'lost']).parse(data);
    },

    async upload(job, pptx) {
      // A fresh object per upload, so a worker whose lease expired cannot
      // overwrite its replacement's deck mid-flight.
      const name = `${job.project_id}/deck/${job.id}-${randomUUID()}.pptx`;
      const { error } = await client.storage.from('cloud-lesson-assets')
        .upload(name, pptx, { contentType: DECK_MIME, upsert: false });
      if (error) throw new Error('Could not save the lesson deck.');
      return client.storage.from('cloud-lesson-assets').getPublicUrl(name).data.publicUrl;
    },

    async complete(job, url, metadata) {
      const { data, error } = await client.rpc('complete_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_output_url: url,
        p_output_metadata: JSON.parse(JSON.stringify(metadata)) as Json,
        p_cost_usd: 0,
      });
      if (error) throw new Error('Could not record the finished deck.');
      return data === true;
    },

    async fail(job, code, message) {
      const { data, error } = await client.rpc('fail_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_error_code: code,
        p_error_message: message, p_retry_delay_seconds: 30, p_cost_usd: 0,
      });
      if (error) throw new Error('Could not record the deck failure.');
      return data === true;
    },
  };
}

export interface RunDeckJobOptions {
  job: DeckJob;
  store: CloudDeckStore;
  /** Injectable so a test can exercise the lifecycle without a planner. */
  build?: (request: DeckRequest, outputPath: string, imageDir: string) => Promise<LessonDeckResult>;
  signal?: AbortSignal;
}

export interface DeckJobResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  url: string | null;
  slideCount: number;
  errorCode: string | null;
}

/**
 * One deck job, start to finish.
 *
 * Progress is reported at the three points a teacher can distinguish: the
 * request was read, the planner answered and the file was built. Each
 * heartbeat is also the ownership check, so a worker whose lease was taken
 * stops instead of uploading over the replacement's work.
 */
export async function runCloudDeckJob(options: RunDeckJobOptions): Promise<DeckJobResult> {
  const { job, store } = options;
  const build = options.build
    ?? ((request, outputPath, imageDir) => buildLessonDeck(request, outputPath, imageDir));

  const stop = (state: HeartbeatState) => {
    if (state === 'cancel') throw new DeckStopped('cancel');
    if (state === 'lost') throw new DeckStopped('lost');
  };

  let workDir: string | null = null;
  try {
    if (options.signal?.aborted) throw new DeckStopped('shutdown');
    stop(await store.heartbeat(job, 5));

    const request = await store.request(job);
    stop(await store.heartbeat(job, 15));

    workDir = await mkdtemp(join(tmpdir(), 'lumina-deck-job-'));
    const outputPath = join(workDir, 'lesson.pptx');
    const result = await build(request, outputPath, workDir);

    // A deck with no slides is a failure the builder did not notice. Checked
    // before upload, because an empty file in storage is harder to explain
    // than a job that failed.
    if (result.slideCount < 1) {
      throw new Error('The deck builder produced a file with no slides.');
    }

    const pptx = await readFile(outputPath);
    if (pptx.length === 0) throw new Error('The deck builder produced an empty file.');
    // A pptx is a zip. Checked here so a truncated write cannot become a
    // download that fails in the teacher's hands instead of in the worker.
    if (!(pptx[0] === 0x50 && pptx[1] === 0x4b)) {
      throw new Error('The deck builder produced a file that is not a .pptx package.');
    }

    stop(await store.heartbeat(job, 80));
    const url = await store.upload(job, pptx);

    await store.complete(job, url, {
      outputKind: 'pptx',
      slideCount: result.slideCount,
      contentMode: result.contentMode,
      plannerModel: result.plannerModel,
      imagesGenerated: result.imagesGenerated,
      imageFailures: result.imageFailures,
      illustrated: result.illustrated,
      byteSize: pptx.length,
    });
    return { status: 'succeeded', url, slideCount: result.slideCount, errorCode: null };
  } catch (error) {
    if (error instanceof DeckStopped) {
      if (error.reason === 'cancel') {
        await store.fail(job, 'deck_cancelled', 'The teacher cancelled this lesson.');
        return { status: 'cancelled', url: null, slideCount: 0, errorCode: 'deck_cancelled' };
      }
      // 'lost' and 'shutdown' are deliberately not reported: another worker
      // owns the job, and writing a failure here would mark its work failed.
      throw error;
    }
    const message = error instanceof Error ? error.message : 'The deck could not be built.';
    const code = /planner/i.test(message) ? 'deck_planner_unavailable' : 'deck_failed';
    await store.fail(job, code, message);
    return { status: 'failed', url: null, slideCount: 0, errorCode: code };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
