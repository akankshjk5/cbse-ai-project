import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { publicEnv, serverEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';
import {
  CLOUD_LESSON_CAMERA_MOVES, CLOUD_LESSON_STORED_VISUAL_STYLES, type CloudLessonStoredVisualStyle,
} from '@/lib/videos/cloud-lesson-contracts';
import { HiggsfieldError, HIGGSFIELD_MODEL, type HiggsfieldProvider } from './higgsfield';
import { PreparationStopped, type HeartbeatState } from './worker';

export const MediaJobSchema = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), owner_id: z.string().min(1),
  scene_id: z.string().uuid().nullable(), kind: z.enum(['video', 'assemble']), status: z.literal('processing'),
  worker_id: z.string().min(1), attempts: z.number().int().positive(), max_attempts: z.number().int().positive(),
  provider_request_id: z.string().uuid().nullable(), cost_usd: z.coerce.number().nonnegative(),
  prompt: z.string().max(4000), negative_prompt: z.string().max(2000),
  source_image_url: z.string().url().nullable(), parameters: z.record(z.string(), z.unknown()),
});
export type MediaJob = z.infer<typeof MediaJobSchema>;
export const MediaSceneSchema = z.object({
  id: z.string().uuid(), scene_index: z.number().int().min(1).max(8), duration_seconds: z.coerce.number().refine(v => v === 7.5),
  caption: z.string().max(120), overlay: z.record(z.string(), z.unknown()),
  title: z.string().min(2).max(60).nullable().optional(), // storybook chapter banner; null for other styles
  motion_mode: z.enum(['animate', 'still']), status: z.string(),
  image_url: z.string().url(), video_url: z.string().url().nullable(),
});
export type MediaScene = z.infer<typeof MediaSceneSchema>;
/** A storybook scene's finished pictures. Shot 1 is the scene's picture and the one Higgsfield animates. */
export const MediaShotSchema = z.object({
  id: z.string().uuid(), scene_id: z.string().uuid(), shot_index: z.number().int().min(1).max(3),
  camera_move: z.enum(CLOUD_LESSON_CAMERA_MOVES), status: z.literal('succeeded'), image_url: z.string().url(),
});
export type MediaShot = z.infer<typeof MediaShotSchema>;
export interface MediaBundle {
  language: 'en-IN' | 'hi-IN' | 'kn-IN'; visualStyle?: CloudLessonStoredVisualStyle; durationSeconds?: 30 | 60; narrationUrl: string; scenes: MediaScene[];
  /** Storybook video jobs only: the claimed scene's shots, in order. */
  shots?: MediaShot[];
}

/**
 * A storybook video job composes its scene from every shot, so all of them must
 * be finished, belong to this scene, run 1..n, and start with the picture the
 * job was queued with. A fresh job also carries the count the database saw.
 */
export function assertStorybookShots(shots: MediaShot[], scene: MediaScene, job: MediaJob): void {
  if (shots.length < 2 || shots.length > 3 || shots.some((shot, i) => shot.shot_index !== i + 1 || shot.scene_id !== scene.id)
    || shots[0].image_url !== scene.image_url || !scene.title
    || (!job.parameters.reusedFromProjectId
      && (job.parameters.visualStyle !== 'storybook' || job.parameters.shotCount !== shots.length))) {
    throw new Error('Invalid storybook shots.');
  }
}

/**
 * One background track per lesson from CLOUD_LESSON_MUSIC_DIR (.wav or .m4a),
 * chosen from the project id so a retry picks the same one. No folder, an empty
 * one, or '' means no music; the narration alone is a complete lesson.
 */
export async function pickLessonMusic(dir: string | undefined, projectId: string): Promise<string | undefined> {
  if (!dir) return undefined;
  const folder = resolve(dir);
  if (!(await stat(folder).catch(() => undefined))?.isDirectory()) throw new Error('CLOUD_LESSON_MUSIC_DIR is not a folder.');
  const tracks = (await readdir(folder, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && ['.wav', '.m4a'].includes(extname(entry.name).toLowerCase()))
    .map(entry => entry.name).sort();
  if (!tracks.length) return undefined;
  const pick = createHash('sha256').update(projectId).digest().readUInt32BE(0) % tracks.length;
  return join(folder, tracks[pick]);
}
export interface CloudMediaStore {
  claim(workerId: string, kinds: ('video' | 'assemble')[]): Promise<MediaJob | null>;
  bundle(job: MediaJob): Promise<MediaBundle>;
  heartbeat(job: MediaJob, progress: number, providerId?: string): Promise<HeartbeatState>;
  upload(job: MediaJob, path: string, label: string): Promise<string>;
  complete(job: MediaJob, url: string, metadata: Record<string, unknown>, cost: number): Promise<boolean>;
  fail(job: MediaJob, code: string, message: string, cost: number): Promise<boolean>;
}

export function createCloudMediaStore(): CloudMediaStore {
  const client = createAdminClient();
  return {
    async claim(workerId, kinds) {
      const { data, error } = await client.rpc('claim_cloud_lesson_job', { p_worker_id: workerId, p_kinds: kinds });
      if (error) throw new Error('Could not claim cloud media job.');
      return data?.[0] ? MediaJobSchema.parse(data[0]) : null;
    },
    async bundle(job) {
      const { data, error } = await client.from('cloud_lesson_projects')
        .select('status,language_code,narration_url,narration_duration_seconds,target_duration_seconds,visual_style,reused_from_project_id')
        .eq('id', job.project_id).eq('owner_id', job.owner_id).single();
      if (error || !data) throw new Error('Could not load this lesson.');
      if (data.status === 'cancelled') throw new PreparationStopped('cancel');
      if (!['generating_images', 'generating_videos', 'assembling'].includes(data.status)
          || ![30, 60].includes(data.target_duration_seconds) || !data.narration_url
          || Math.abs(Number(data.narration_duration_seconds) - data.target_duration_seconds) > 0.25) throw new Error('Invalid active lesson.');
      const { data: rows, error: sceneError } = await client.from('cloud_lesson_scenes')
        .select('id,scene_index,duration_seconds,caption,overlay,title,motion_mode,status,image_url,video_url')
        .eq('project_id', job.project_id).order('scene_index');
      if (sceneError || !rows) throw new Error('Could not load lesson scenes.');
      // Video jobs may run before later keyframes exist. Only parse their own scene,
      // while checking the animation cap against all eight stored rows.
      if (rows.length !== data.target_duration_seconds / 7.5 || rows.filter(s => s.motion_mode === 'animate').length > 6) throw new Error('Invalid scene plan.');
      const relevant = job.kind === 'video' ? rows.filter(s => s.id === job.scene_id) : rows;
      const scenes = z.array(MediaSceneSchema).parse(relevant);
      if (job.parameters.reusedFromProjectId) {
        const sourceId = z.string().uuid().parse(job.parameters.reusedFromProjectId);
        if (sourceId !== data.reused_from_project_id) throw new Error('Invalid reuse source.');
        const { data: source, error: sourceError } = await client.from('cloud_lesson_projects').select('id')
          .eq('id', sourceId).eq('owner_id', job.owner_id).eq('status', 'succeeded').single();
        if (sourceError || !source) throw new Error('Reuse source is unavailable.');
      }
      if (job.kind === 'video' && (scenes.length !== 1 || scenes[0].status !== 'generating_video'
        || scenes[0].image_url !== job.source_image_url
        || scenes[0].motion_mode !== job.parameters.motionMode || scenes[0].scene_index !== job.parameters.sceneIndex
        || job.parameters.clipSeconds !== 5 || job.parameters.slotSeconds !== 7.5)) throw new Error('Invalid video claim.');
      if (job.kind === 'assemble' && (data.status !== 'assembling' || scenes.some((s, i) =>
        s.scene_index !== i + 1 || s.status !== 'succeeded' || !s.video_url))) throw new Error('Lesson is not ready to assemble.');
      const visualStyle = z.enum(CLOUD_LESSON_STORED_VISUAL_STYLES).parse(data.visual_style);
      let shots: MediaShot[] | undefined;
      if (visualStyle === 'storybook' && job.kind === 'video') {
        const { data: shotRows, error: shotError } = await client.from('cloud_lesson_shots')
          .select('id,scene_id,shot_index,camera_move,status,image_url')
          .eq('project_id', job.project_id).eq('scene_id', scenes[0].id).order('shot_index');
        if (shotError || !shotRows) throw new Error('Could not load storybook shots.');
        shots = z.array(MediaShotSchema).parse(shotRows);
        assertStorybookShots(shots, scenes[0], job);
      } else if (visualStyle !== 'storybook' && job.parameters.visualStyle === 'storybook') {
        throw new Error('Invalid video claim.');
      }
      return { durationSeconds: z.union([z.literal(30), z.literal(60)]).parse(data.target_duration_seconds), visualStyle, language: z.enum(['en-IN', 'hi-IN', 'kn-IN']).parse(data.language_code), narrationUrl: data.narration_url, scenes, ...(shots ? { shots } : {}) };
    },
    async heartbeat(job, progress, providerId) {
      const { data, error } = await client.rpc('heartbeat_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_progress: progress,
        ...(providerId ? { p_provider_request_id: providerId } : {}),
      });
      if (error) throw new Error('Could not verify media ownership.');
      return z.enum(['ok', 'cancel', 'lost']).parse(data);
    },
    async upload(job, path, label) {
      const name = `${job.project_id}/media/${job.id}-${label}-${randomUUID()}.mp4`;
      const { error } = await client.storage.from('cloud-lesson-assets').upload(name, await readFile(path),
        { contentType: 'video/mp4', upsert: false });
      if (error) throw new Error('Could not save lesson media.');
      return client.storage.from('cloud-lesson-assets').getPublicUrl(name).data.publicUrl;
    },
    async complete(job, url, metadata, cost) {
      const { data, error } = await client.rpc('complete_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_output_url: url,
        p_output_metadata: JSON.parse(JSON.stringify(metadata)) as Json, p_cost_usd: cost,
      });
      if (error) throw new Error('Could not complete lesson media.');
      return data === true;
    },
    async fail(job, code, message, cost) {
      const { data, error } = await client.rpc('fail_cloud_lesson_job', {
        p_job_id: job.id, p_worker_id: job.worker_id, p_error_code: code,
        p_error_message: message, p_retry_delay_seconds: 30, p_cost_usd: cost,
      });
      if (error) throw new Error('Could not record lesson media failure.');
      return data === true;
    },
  };
}

/** Restrict every source before download; redirects cannot bypass the restriction. */
export function mediaAssetUrl(url: string, projectId: string, supabaseUrl: string, providerHosts?: string[]): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Invalid media URL.');
  if (providerHosts) {
    if (!providerHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error('Unapproved provider media host.');
  } else {
    if (parsed.origin !== new URL(supabaseUrl).origin || parsed.search || parsed.hash || /%|\\/.test(parsed.pathname)
      || !parsed.pathname.startsWith(`/storage/v1/object/public/cloud-lesson-assets/${projectId}/`)) throw new Error('Invalid lesson asset URL.');
  }
  return parsed;
}
export async function downloadMedia(url: URL, path: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('Could not download lesson media.');
  const max = 250 * 1024 * 1024;
  if (Number(response.headers.get('content-length') || 0) > max) throw new Error('Media download exceeds size limit.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw new Error('Media download exceeds size limit.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  await writeFile(path, Buffer.concat(chunks));
}

export interface CloudMediaRenderer {
  preflight(): Promise<void>;
  render(manifest: Record<string, unknown>, dir: string, signal: AbortSignal): Promise<Record<string, unknown>>;
}
/** Python receives local paths only, never service keys or provider credentials. */
export function createCloudMediaRenderer(): CloudMediaRenderer {
  const executable = serverEnv.cloudLessonPython;
  const script = resolve('ops/cloud/compositor.py');
  const config = { ffmpeg: serverEnv.cloudLessonFfmpeg, ffprobe: serverEnv.cloudLessonFfprobe, fontsDir: resolve(serverEnv.cloudLessonFontsDir) };
  const invoke = (args: string[], signal?: AbortSignal) => new Promise<string>((resolveCall, reject) => {
    const child = spawn(executable, [script, ...args], { windowsHide: true, signal,
      env: serverEnv.cloudLessonSubprocessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Cloud composition exceeded its deadline.')); }, 30 * 60_000);
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveCall(stdout) : reject(new Error(`Cloud composition failed: ${stderr}`)); });
  });
  return {
    async preflight() { await invoke(['--preflight', '--config', JSON.stringify(config)]); },
    async render(manifest, dir, signal) {
      const path = join(dir, 'manifest.json');
      await writeFile(path, JSON.stringify({ ...manifest, ...config }));
      return z.record(z.string(), z.unknown()).parse(JSON.parse(await invoke(['--manifest', path], signal)));
    },
  };
}

export interface RunMediaOptions {
  job: MediaJob; store: CloudMediaStore; provider?: HiggsfieldProvider; renderer: CloudMediaRenderer;
  signal?: AbortSignal; heartbeatMs?: number; pollMs?: number; providerDeadlineMs?: number;
  usdPerSecond?: number; download?: typeof downloadMedia;
  /** Storybook music folder; defaults to CLOUD_LESSON_MUSIC_DIR, '' turns music off. */
  musicDir?: string;
  assetUrl?: (url: string, provider: boolean) => URL;
  onStage?: (stage: string, progress: number) => void;
}
export async function runCloudMediaJob(options: RunMediaOptions) {
  const job = MediaJobSchema.parse(options.job);
  let progress = 1; let providerId = job.provider_request_id ?? undefined; let stopped: PreparationStopped | undefined;
  let providerFinished = false; let costUsd = 0; let heartbeatPending: Promise<void> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
  const assertActive = () => {
    if (stopped) throw stopped;
    if (options.signal?.aborted) throw new PreparationStopped('shutdown');
  };
  const beat = async () => {
    assertActive();
    if (!heartbeatPending) heartbeatPending = (async () => {
      try {
        const state = await options.store.heartbeat(job, progress, providerId);
        if (state !== 'ok') { stopped = new PreparationStopped(state); controller.abort(); }
      } catch { stopped = new PreparationStopped('lost'); controller.abort(); }
    })();
    const pending = heartbeatPending; await pending;
    if (heartbeatPending === pending) heartbeatPending = undefined;
    assertActive();
  };
  const checkpoint = async (stage: string, percent: number) => {
    progress = Math.max(progress, percent); await beat(); options.onStage?.(stage, progress);
  };
  const assetUrl = options.assetUrl ?? ((url, provider) => mediaAssetUrl(url,
    job.kind === 'video' && job.parameters.reusedFromProjectId
      ? z.string().uuid().parse(job.parameters.reusedFromProjectId) : job.project_id, publicEnv.supabaseUrl,
    provider ? serverEnv.cloudLessonProviderMediaHosts : undefined));
  const download = async (url: string, path: string, provider = false) => {
    await beat(); await (options.download ?? downloadMedia)(assetUrl(url, provider), path); await beat();
  };
  const retryProvider = async <T,>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      await beat();
      try { return await fn(); } catch (error) {
        if (attempt >= 3 || (error instanceof HiggsfieldError && error.status !== undefined
          && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
        await delay(options.pollMs ?? (1000 * 2 ** attempt + Math.random() * 500), undefined, { signal: controller.signal });
      }
    }
  };
  const timer = setInterval(() => { void beat().catch(() => undefined); }, options.heartbeatMs ?? 15_000);
  let dir: string | undefined;
  try {
    await checkpoint('claimed', 1);
    const bundle = await options.store.bundle(job);
    await mkdir(resolve('generated/cloud-media'), { recursive: true });
    dir = await mkdtemp(resolve('generated/cloud-media/job-'));
    const output = join(dir, 'output.mp4'); const metadata: Record<string, unknown> = {};
    if (job.kind === 'video') {
      const scene = bundle.scenes[0];
      const storybook = bundle.visualStyle === 'storybook';
      let image = join(dir, 'image.png');
      const shots: { image: string; cameraMove: string }[] = [];
      if (storybook) {
        // Shot 1 is the scene's picture, so it is downloaded once, as a shot.
        if (!bundle.shots) throw new Error('Storybook shots are missing.');
        assertStorybookShots(bundle.shots, scene, job);
        for (const shot of bundle.shots) {
          const path = join(dir, `shot-${shot.shot_index}.png`);
          await download(shot.image_url, path); shots.push({ image: path, cameraMove: shot.camera_move });
        }
        image = shots[0].image;
      } else {
        await download(scene.image_url, image);
      }
      let rawClip: string | undefined;
      if (scene.motion_mode === 'animate' && job.parameters.reusedFromProjectId) {
        const rawUrl = z.string().url().parse(job.parameters.reusedRawVideoUrl);
        rawClip = join(dir, 'raw.mp4');
        await checkpoint('reuse-animation', 55);
        await download(rawUrl, rawClip);
        metadata.rawVideoUrl = rawUrl;
        metadata.reusedFromProjectId = job.parameters.reusedFromProjectId;
      } else if (scene.motion_mode === 'animate') {
        if (!options.provider) throw new Error('Higgsfield provider is missing.');
        const provider = options.provider;
        if (!providerId) {
          await checkpoint('submit-animation', 10);
          // Stable across lease recovery and ambiguous POST responses; body is
          // derived solely from immutable job columns, never runtime model settings.
          const receipt = await retryProvider(() => provider.submit({ prompt: job.prompt,
            negative_prompt: job.negative_prompt, image_url: scene.image_url }, `cloud-lesson:${job.id}`));
          providerId = receipt.request_id;
          await beat(); // Drain a timer heartbeat that may have started before the ID was assigned.
          await checkpoint('persist-provider-request', 15);
        }
        const deadline = Date.now() + (options.providerDeadlineMs ?? 20 * 60_000);
        while (true) {
          await checkpoint('poll-animation', 30);
          const result = await retryProvider(() => provider.status(providerId!));
          if (result.status === 'completed') {
            providerFinished = true;
            costUsd = Math.round(Math.max(0, 5 * (options.usdPerSecond ?? serverEnv.cloudLessonHiggsfieldUsdPerSecond) - job.cost_usd) * 1e6) / 1e6;
            if (!result.video) throw new Error('Provider returned no video.');
            rawClip = join(dir, 'raw.mp4'); await download(result.video.url, rawClip, true);
            await checkpoint('retain-raw-animation', 55);
            metadata.rawVideoUrl = await options.store.upload(job, rawClip, 'raw');
            break;
          }
          if (['failed', 'nsfw', 'canceled'].includes(result.status)) throw new HiggsfieldError();
          if (Date.now() >= deadline) throw new Error('Provider generation exceeded its deadline.');
          await delay(options.pollMs ?? 5_000, undefined, { signal: controller.signal });
        }
        metadata.provider = 'higgsfield'; metadata.model = HIGGSFIELD_MODEL; metadata.providerRequestId = providerId;
        metadata.estimatedGenerationCostUsd = 5 * (options.usdPerSecond ?? serverEnv.cloudLessonHiggsfieldUsdPerSecond);
        metadata.costIsEstimate = true;
      }
      await checkpoint('compose-scene', 65);
      Object.assign(metadata, await options.renderer.render({ mode: 'scene', image, rawClip, output,
        visualStyle: bundle.visualStyle ?? "editorial", durationSeconds: bundle.durationSeconds ?? 60, language: bundle.language, scene,
        ...(storybook ? { shots } : {}) }, dir, controller.signal));
    } else {
      const clips: string[] = [];
      for (const scene of bundle.scenes) { const path = join(dir, `scene-${scene.scene_index}.mp4`);
        await download(scene.video_url!, path); clips.push(path); }
      const narration = join(dir, 'narration.wav'); await download(bundle.narrationUrl, narration);
      // Only storybook lessons get a music bed; the other styles assemble exactly as before.
      const music = bundle.visualStyle === 'storybook'
        ? await pickLessonMusic(options.musicDir ?? serverEnv.cloudLessonMusicDir, job.project_id) : undefined;
      if (music) metadata.musicTrack = basename(music);
      await checkpoint('assemble-lesson', 65);
      Object.assign(metadata, await options.renderer.render({ mode: 'assemble', clips, narration, output,
        visualStyle: bundle.visualStyle ?? "editorial", durationSeconds: bundle.durationSeconds ?? 60, language: bundle.language, scenes: bundle.scenes,
        ...(music ? { music } : {}) }, dir, controller.signal));
    }
    await checkpoint('upload-media', 90);
    const url = await options.store.upload(job, output, job.kind === 'assemble' ? 'lesson' : 'scene');
    await checkpoint('save-media', 98);
    if (!await options.store.complete(job, url, metadata, costUsd)) throw new PreparationStopped('lost');
    return { status: 'completed', costUsd };
  } catch (error) {
    const reason = () => stopped?.reason ?? (error instanceof PreparationStopped ? error.reason : undefined);
    if (reason() === 'lost') return { status: 'lost', costUsd };
    if (options.signal?.aborted || reason() === 'shutdown') return { status: 'shutdown', costUsd };
    try { await beat(); } catch { /* inspect lease state below */ }
    if (reason() === 'lost') return { status: 'lost', costUsd };
    if (reason() === 'cancel' && providerId && !providerFinished && options.provider) {
      // In-progress requests cannot be cancelled. Never cancel on lease loss:
      // a replacement worker may already be polling this same request.
      await options.provider.cancel(providerId).catch(() => undefined);
    }
    const cancelled = reason() === 'cancel';
    const code = cancelled ? 'cloud_media_cancelled' : error instanceof HiggsfieldError ? 'higgsfield_failed' : 'cloud_media_failed';
    const providerMessages: Record<number, string> = {
      401: 'Higgsfield API credentials were rejected. Please ask the administrator to check the cloud lesson setup.',
      403: 'The Higgsfield API balance is insufficient. Please ask the administrator to top up the API account.',
      404: 'The Higgsfield model or saved request is unavailable. Please ask the administrator to check API access.',
      422: 'Higgsfield rejected the generation settings. Please ask the administrator to check the cloud lesson setup.',
      429: 'Higgsfield reached its request limit. Please try again shortly.',
    };
    const message = cancelled ? 'Lesson generation cancelled.'
      : error instanceof HiggsfieldError && error.status && providerMessages[error.status]
        ? providerMessages[error.status]
        : 'Lesson animation or composition could not finish. Please check the cloud media worker.';
    const saved = await options.store.fail(job, code, message, costUsd);
    return { status: saved ? cancelled ? 'cancelled' : 'failed' : 'lost', costUsd };
  } finally {
    clearInterval(timer); options.signal?.removeEventListener('abort', abort);
    if (heartbeatPending) await heartbeatPending;
    if (dir && resolve(dir).startsWith(resolve('generated/cloud-media') + sep)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
