import 'server-only';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';
import { PrepareCloudLessonInputSchema, type PrepareCloudLessonInput } from '@/lib/videos/cloud-lesson-contracts';

import { GeminiCallError, geminiTransport, type GeminiTransport } from './gemini';
import { CloudLessonSourcePlanSchema, type CloudLessonSourcePlan, prepareCloudLesson, type PreparedCloudLesson, type PrepareCloudLessonOptions } from './prepare';
import { CostMeter } from './pricing';

export const PrepareJobSchema = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), owner_id: z.string().min(1),
  kind: z.literal('prepare'), status: z.literal('processing'), worker_id: z.string().min(1),
  attempts: z.number().int().positive(), max_attempts: z.number().int().positive(),
});
export type PrepareJob = z.infer<typeof PrepareJobSchema>;
export type HeartbeatState = 'ok' | 'cancel' | 'lost';

/** The worker's database boundary is injectable for offline lifecycle tests. */
export interface CloudPreparationStore {
  claim(workerId: string): Promise<PrepareJob | null>;
  project(job: PrepareJob): Promise<PrepareCloudLessonInput>;
  sourcePlan?(job: PrepareJob): Promise<CloudLessonSourcePlan | undefined>;
  heartbeat(job: PrepareJob, progress: number): Promise<HeartbeatState>;
  upload(job: PrepareJob, wav: Buffer): Promise<string>;
  complete(job: PrepareJob, lesson: PreparedCloudLesson, narrationUrl: string): Promise<boolean>;
  fail(job: PrepareJob, code: string, message: string, costUsd: number): Promise<boolean>;
}

/** Only called by the CLI worker, never by a page or user-facing API. */
export function createCloudPreparationStore(): CloudPreparationStore {
  const client = createAdminClient();
  return {
    async claim(workerId) {
      const { data, error } = await client.rpc('claim_cloud_lesson_job', { p_worker_id: workerId, p_kinds: ['prepare'] });
      if (error) throw new Error(`Could not claim cloud preparation: ${error.message}`);
      return data?.[0] ? PrepareJobSchema.parse(data[0]) : null;
    },
    async project(job) {
      // Both predicates matter: service role bypasses RLS, so an unrelated
      // project's content must never be read on a mismatched queue claim.
      const { data, error } = await client.from('cloud_lesson_projects')
        .select('class_level,subject,topic,language_code,target_duration_seconds,visual_style,status')
        .eq('id', job.project_id).eq('owner_id', job.owner_id).single();
      if (error || !data) throw new Error('Could not load this lesson request.');
      if (data.status === 'cancelled') throw new PreparationStopped('cancel');
      if (data.status !== 'preparing' || ![30, 60].includes(data.target_duration_seconds)) throw new Error('This request is not an active lesson.');
      return PrepareCloudLessonInputSchema.parse({ classLevel: data.class_level, subject: data.subject, topic: data.topic, languageCode: data.language_code, durationSeconds: data.target_duration_seconds, visualStyle: data.visual_style });
    },
    async sourcePlan(job) {
      const { data: project, error } = await client.from('cloud_lesson_projects')
        .select('reused_from_project_id,content_key').eq('id', job.project_id).eq('owner_id', job.owner_id).single();
      if (error || !project) throw new Error('Could not check visual reuse.');
      if (!project.reused_from_project_id) return undefined;
      const { data: source, error: sourceError } = await client.from('cloud_lesson_projects').select('id')
        .eq('id', project.reused_from_project_id).eq('owner_id', job.owner_id)
        .eq('content_key', project.content_key!).eq('status', 'succeeded').single();
      if (sourceError || !source) throw new Error('Visual reuse source is unavailable.');
      const { data: preparation, error: planError } = await client.from('cloud_lesson_jobs').select('output_metadata')
        .eq('project_id', source.id).eq('owner_id', job.owner_id).eq('kind', 'prepare').eq('status', 'succeeded').single();
      if (planError || !preparation) throw new Error('Audited source plan is unavailable.');
      return CloudLessonSourcePlanSchema.parse(z.object({ sourcePlan: z.unknown() }).parse(preparation.output_metadata).sourcePlan);
    },
    async heartbeat(job, progress) {
      const { data, error } = await client.rpc('heartbeat_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_progress: progress,
      });
      if (error) throw new Error('Could not verify cloud preparation ownership.');
      return z.enum(['ok', 'cancel', 'lost']).parse(data);
    },
    async upload(job, wav) {
      // A separate object for every upload avoids an expired worker overwriting
      // the replacement worker's narration.wav during an in-flight upload.
      const name = `${job.project_id}/narration/${job.id}-${randomUUID()}.wav`;
      const { error } = await client.storage.from('cloud-lesson-assets').upload(name, wav, { contentType: 'audio/wav', upsert: false });
      if (error) throw new Error('Could not save the lesson narration.');
      return client.storage.from('cloud-lesson-assets').getPublicUrl(name).data.publicUrl;
    },
    async complete(job, lesson, narrationUrl) {
      const { data, error } = await client.rpc('complete_cloud_lesson_preparation', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_title: lesson.title,
        p_learning_objective: lesson.learningObjective, p_narration_text: lesson.narrationText,
        p_narration_url: narrationUrl, p_narration_duration_seconds: lesson.narration.durationSeconds,
        p_scenes: JSON.parse(JSON.stringify(lesson.scenes)) as Json,
        p_cost_usd: lesson.costUsd, p_output_metadata: JSON.parse(JSON.stringify(lesson.metadata)) as Json,
      });
      if (error) throw new Error('Could not finish saving the lesson preparation.');
      return data === true;
    },
    async fail(job, code, message, costUsd) {
      const { data, error } = await client.rpc('fail_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_error_code: code,
        p_error_message: message, p_retry_delay_seconds: 30, p_cost_usd: costUsd,
      });
      if (error) throw new Error('Could not record the lesson preparation failure.');
      return data === true;
    },
  };
}

export class PreparationStopped extends Error {
  constructor(readonly reason: 'cancel' | 'lost' | 'shutdown') {
    super(`Preparation stopped: ${reason}`);
    this.name = 'PreparationStopped';
  }
}

export function preparationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof PreparationStopped) return { code: `preparation_${error.reason}`, message: error.reason === 'cancel' ? 'Lesson generation cancelled.' : 'Preparation interrupted; queued work will recover.' };
  if (error instanceof GeminiCallError) {
    const messages = {
      gemini_quota: 'The lesson service reached its Gemini quota. Please try again after the quota resets.',
      gemini_unavailable: 'The lesson service is temporarily unavailable. Please try again shortly.',
      gemini_rejected: 'The configured Gemini model or credentials were rejected. Please ask the administrator to check the cloud lesson setup.',
      gemini_blocked: 'The lesson service could not process this topic. Please try a different educational topic.',
      gemini_empty: 'The lesson service returned no content. Please try again.',
      gemini_invalid_output: 'The lesson did not pass its content or format checks. Please try a more specific topic.',
    };
    return { code: error.code, message: messages[error.code] };
  }
  // Never send arbitrary provider error bodies, credentials, or stack traces to a teacher.
  if (error instanceof Error && /narration does not fit|silent or truncated/i.test(error.message)) {
    return { code: 'narration_fit_failed', message: 'The narration could not fit the scene timing clearly. Please try a more focused topic.' };
  }
  if (error instanceof Error && /numbers not supported/i.test(error.message)) {
    return { code: 'reference_audit_failed', message: 'The lesson contained details unsupported by its reference. Please try a more specific topic.' };
  }
  return { code: 'cloud_preparation_failed', message: 'Lesson preparation could not finish. Please try again or ask the administrator to check the worker.' };
}

export interface RunPreparationOptions extends Omit<PrepareCloudLessonOptions, 'input' | 'checkpoint'> {
  job: PrepareJob;
  store: CloudPreparationStore;
  signal?: AbortSignal;
  heartbeatMs?: number;
  onStage?: (stage: string, progress: number) => void;
}
export type PreparationRunResult = { status: 'completed' | 'failed' | 'cancelled' | 'lost' | 'shutdown'; costUsd: number };

/** Process one claimed job. Its heartbeat is alive even during long Gemini calls. */
export async function runCloudPreparationJob(options: RunPreparationOptions): Promise<PreparationRunResult> {
  const job = PrepareJobSchema.parse(options.job);
  const meter = options.meter ?? new CostMeter();
  let progress = 0;
  let stopped: PreparationStopped | undefined;
  const stoppedReason = () => stopped?.reason;
  let heartbeatPending: Promise<void> | undefined;
  const assertActive = () => {
    if (stopped) throw stopped;
    if (options.signal?.aborted) throw new PreparationStopped('shutdown');
  };
  const beat = async () => {
    assertActive();
    if (!heartbeatPending) {
      heartbeatPending = (async () => {
        try {
          const state = await options.store.heartbeat(job, progress);
          if (state !== 'ok') stopped = new PreparationStopped(state);
        } catch {
          // If ownership cannot be verified, stop spending and writing. Let
          // database lease recovery decide which worker is next.
          stopped = new PreparationStopped('lost');
        }
      })();
    }
    const pending = heartbeatPending;
    await pending;
    if (heartbeatPending === pending) heartbeatPending = undefined;
    assertActive();
  };
  const checkpoint = async (stage: string, percent: number) => {
    progress = Math.max(progress, percent);
    await beat();
    options.onStage?.(stage, progress);
  };
  const transport: GeminiTransport = {
    async generateContent(request) {
      await beat();
      const response = await (options.transport ?? geminiTransport()).generateContent(request);
      // Return the response so Gemini records its billed usage. The next
      // checkpoint/provider call rejects cancelled or lost work.
      return response;
    },
  };
  const timer = setInterval(() => { void beat().catch(() => undefined); }, options.heartbeatMs ?? 15_000);
  try {
    await checkpoint('claimed', 1);
    const input = await options.store.project(job);
    const sourcePlan = await options.store.sourcePlan?.(job);
    await beat();
    const prepared = await prepareCloudLesson({ ...options, sourcePlan, input, meter, transport, checkpoint });
    await checkpoint('upload-narration', 95);
    const narrationUrl = await options.store.upload(job, prepared.narration.wav);
    await checkpoint('save-preparation', 98);
    if (!await options.store.complete(job, prepared, narrationUrl)) throw new PreparationStopped('lost');
    return { status: 'completed', costUsd: meter.totalUsd };
  } catch (error) {
    if (stopped?.reason === 'lost' || (error instanceof PreparationStopped && error.reason === 'lost')) {
      return { status: 'lost', costUsd: meter.totalUsd };
    }
    if (options.signal?.aborted || (error instanceof PreparationStopped && error.reason === 'shutdown')) {
      // Leave the lease for recovery, rather than spending a retry on shutdown.
      return { status: 'shutdown', costUsd: meter.totalUsd };
    }
    // Refresh the lease before recording failure; cancellation racing a Gemini
    // rejection must not turn a cancelled lesson back into queued work.
    try { await beat(); } catch { /* state is inspected below */ }
    if (stoppedReason() === 'lost') return { status: 'lost', costUsd: meter.totalUsd };
    const failure = preparationFailure(stopped ?? error);
    const accepted = await options.store.fail(job, failure.code, failure.message, meter.totalUsd);
    const cancelled = stoppedReason() === 'cancel' || (error instanceof PreparationStopped && error.reason === 'cancel');
    return { status: accepted ? cancelled ? 'cancelled' : 'failed' : 'lost', costUsd: meter.totalUsd };
  } finally {
    clearInterval(timer);
    if (heartbeatPending) await heartbeatPending;
  }
}
