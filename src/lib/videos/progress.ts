import type { LessonVideoProject, LessonVideoScene } from '@/lib/videos/lesson-contracts';

export interface LessonProgressJob {
  kind: string;
  scene_id: string | null;
  status: string;
  progress: number;
  started_at: string | null;
  output_metadata: unknown;
}

export interface LessonProgressSnapshot {
  progress: number;
  etaSeconds: number | null;
  sceneProgress: Record<string, number>;
  completedClips: number;
  totalClips: number;
  activeSceneIndex: number | null;
}

const DEFAULT_SECONDS: Record<'image' | 'video' | 'assemble', number> = {
  image: 16,
  video: 58,
  assemble: 20,
};

function metadataLatency(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const latency = (metadata as { latency_seconds?: unknown }).latency_seconds;
  if (!latency || typeof latency !== 'object') return null;
  const total = Number((latency as { total?: unknown }).total);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function estimateFor(kind: 'image' | 'video' | 'assemble', jobs: LessonProgressJob[]): number {
  const measured = jobs
    .filter((job) => job.kind === kind && job.status === 'succeeded')
    .map((job) => metadataLatency(job.output_metadata))
    .filter((value): value is number => value !== null);
  return median(measured) ?? DEFAULT_SECONDS[kind];
}

function jobFraction(job: LessonProgressJob | undefined, estimate: number, now: number): number {
  if (!job) return 0;
  if (job.status === 'succeeded') return 1;
  if (job.status !== 'processing') return 0;
  const reported = Math.max(0, Math.min(0.95, Number(job.progress || 0) / 100));
  const started = job.started_at ? Date.parse(job.started_at) : Number.NaN;
  const elapsedFraction = Number.isFinite(started)
    ? Math.min(0.9, Math.max(0, (now - started) / 1000 / estimate) * 0.9)
    : 0;
  return Math.max(reported, elapsedFraction);
}

export function lessonProgressSnapshot(
  project: LessonVideoProject,
  scenes: LessonVideoScene[],
  jobs: LessonProgressJob[],
  now = Date.now(),
): LessonProgressSnapshot {
  if (project.status === 'preparing') {
    return {
      progress: 0,
      etaSeconds: null,
      sceneProgress: {},
      completedClips: 0,
      totalClips: 0,
      activeSceneIndex: null,
    };
  }
  if (project.status === 'succeeded') {
    return {
      progress: 100,
      etaSeconds: 0,
      sceneProgress: Object.fromEntries(scenes.map((scene) => [scene.id, 100])),
      completedClips: scenes.length,
      totalClips: scenes.length,
      activeSceneIndex: null,
    };
  }

  const imageSeconds = estimateFor('image', jobs);
  const videoSeconds = estimateFor('video', jobs);
  const assemblySeconds = estimateFor('assemble', jobs);
  const sceneProgress: Record<string, number> = {};
  let completedWork = 0;
  let activeSceneIndex: number | null = null;

  for (const scene of scenes) {
    // A rejected storyboard may leave cancelled attempts behind and enqueue a
    // replacement job. The API returns jobs oldest-first, so use the latest
    // active attempt and trust saved media URLs over historical job rows.
    const imageJob = jobs.findLast((job) => job.scene_id === scene.id
      && job.kind === 'image' && job.status !== 'cancelled');
    const videoJob = jobs.findLast((job) => job.scene_id === scene.id
      && job.kind === 'video' && job.status !== 'cancelled');
    const imageFraction = scene.image_url ? 1 : jobFraction(imageJob, imageSeconds, now);
    const videoFraction = scene.video_url ? 1 : jobFraction(videoJob, videoSeconds, now);
    completedWork += imageSeconds * imageFraction + videoSeconds * videoFraction;
    const percent = Math.round(
      ((imageSeconds * imageFraction + videoSeconds * videoFraction)
        / (imageSeconds + videoSeconds)) * 100,
    );
    sceneProgress[scene.id] = scene.status === 'succeeded' ? 100 : Math.min(99, percent);
    if (activeSceneIndex === null && (
      scene.status === 'generating_image' || scene.status === 'generating_video'
    )) activeSceneIndex = scene.scene_index;
  }

  const assemblyJob = jobs.find((job) => job.kind === 'assemble');
  completedWork += assemblySeconds * jobFraction(assemblyJob, assemblySeconds, now);
  const totalWork = Math.max(1, scenes.length * (imageSeconds + videoSeconds) + assemblySeconds);
  const terminal = project.status === 'failed' || project.status === 'cancelled';
  const progress = terminal ? 0 : Math.min(99, Math.round((completedWork / totalWork) * 100));
  const etaSeconds = terminal ? null : Math.max(0, Math.round(totalWork - completedWork));

  return {
    progress,
    etaSeconds,
    sceneProgress,
    completedClips: scenes.filter((scene) => Boolean(scene.video_url)).length,
    totalClips: scenes.length,
    activeSceneIndex,
  };
}
