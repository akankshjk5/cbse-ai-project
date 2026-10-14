/**
 * The contract every lesson generator answers to.
 *
 * There are two working engines in this repository and they were built
 * independently: the cloud engine (`src/lib/cloud-lesson/`, Gemini for planning,
 * narration and pictures, Higgsfield for motion) and the self-hosted engine
 * (`ops/runpod/`, Z-Image and Wan 2.2 behind ComfyUI). They have separate
 * schemas, separate queues and separate claim RPCs, which is the right call —
 * neither can break the other — but it leaves callers choosing between two
 * shapes that describe the same job.
 *
 * This is the one shape. It exists so that:
 *
 *  - the API and the UI never name a provider. A route asks for a lesson; which
 *    engine makes it is a deployment decision, not a code path.
 *  - a third provider is an implementation of this interface and nothing else.
 *    No RunPod API appears anywhere above the adapter, and none does today —
 *    the self-hosted worker speaks only Postgres and ComfyUI over HTTP, so it
 *    already runs on any box with a GPU.
 *  - cost and capability are declared rather than discovered. A caller can ask
 *    what a lesson will cost before it spends anything.
 *
 * What it deliberately does NOT do is merge the two schemas. Each adapter owns
 * its own tables; this layer only normalises what a caller sees.
 */

/**
 * The statuses a caller may observe, in the order they occur.
 *
 * Both engines store their own narrower enums — `cloud_lesson_projects.status`
 * and `lesson_video_projects.status`, which happen to share seven values — and
 * both omit the two stages that only exist once a deck and a lesson share a
 * scene list. Those are here because the contract should describe the pipeline
 * the product is heading for, not only the part that is wired today;
 * `PPT_GENERATED` is reported by no adapter yet, and that is visible rather
 * than hidden.
 */
export const LESSON_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'PPT_GENERATED',
  'VISUALS_GENERATED',
  'AUDIO_GENERATED',
  'VIDEO_RENDERING',
  'UPLOADING',
  'COMPLETED',
  'FAILED',
] as const;

export type LessonStatus = (typeof LESSON_STATUSES)[number];

/** Statuses after which no further work happens. */
export const TERMINAL_LESSON_STATUSES: readonly LessonStatus[] = ['COMPLETED', 'FAILED'];

export function isTerminal(status: LessonStatus): boolean {
  return TERMINAL_LESSON_STATUSES.includes(status);
}

/**
 * How far through the pipeline a status sits, 0 to 1.
 *
 * Shared by every adapter so two providers reporting the same stage move the
 * bar to the same place — the same reason `src/lib/generation/stages.ts` keeps
 * one ordered list for the deck build. A caller may creep the bar between
 * marks; it must never promise progress a provider has not reported.
 */
const PROGRESS: Record<LessonStatus, number> = {
  QUEUED: 0.02,
  PROCESSING: 0.12,
  PPT_GENERATED: 0.3,
  VISUALS_GENERATED: 0.5,
  AUDIO_GENERATED: 0.62,
  VIDEO_RENDERING: 0.8,
  UPLOADING: 0.94,
  COMPLETED: 1,
  FAILED: 1,
};

export function progressFor(status: LessonStatus): number {
  return PROGRESS[status];
}

/**
 * The seven-value status both engines happen to store, mapped to the contract.
 *
 * Kept as one function rather than one per adapter because the two enums are
 * identical today. If they diverge, this splits — it does not grow a provider
 * flag.
 */
const STORED: Record<string, LessonStatus> = {
  preparing: 'PROCESSING',
  generating_images: 'VISUALS_GENERATED',
  generating_videos: 'VIDEO_RENDERING',
  assembling: 'UPLOADING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'FAILED',
};

/**
 * Anything unrecognised is PROCESSING, never COMPLETED.
 *
 * A status this layer does not know about means a provider moved ahead of it.
 * Reporting that as finished would hand a caller a lesson with no video;
 * reporting it as in-flight costs a poll.
 */
export function fromStoredStatus(stored: string): LessonStatus {
  return STORED[stored] ?? 'PROCESSING';
}

export type LessonLanguage = 'en-IN' | 'hi-IN' | 'kn-IN';
export type LessonVisualStyle = 'illustrated' | 'editorial' | 'storybook';
export type LessonDifficulty = 'foundational' | 'standard' | 'advanced';

/** What a teacher asked for. The reuse key in Postgres is built from these. */
export interface LessonRequest {
  classLevel: number;
  subject: string;
  topic: string;
  chapter?: string | null;
  language: LessonLanguage;
  durationSeconds: 30 | 60;
  visualStyle: LessonVisualStyle;
  difficulty?: LessonDifficulty;
}

export interface ReservedLesson {
  lessonId: string;
  status: LessonStatus;
  /** True when the request was answered from an existing lesson, at no cost. */
  cached: boolean;
  /** True when a new lesson was opened but its pictures come from an existing one. */
  reusedVisuals: boolean;
}

export interface LessonProgress {
  lessonId: string;
  status: LessonStatus;
  progress: number;
  videoUrl: string | null;
  pptxUrl: string | null;
  error: string | null;
  /** What the provider has recorded spending so far, or null when it does not price. */
  costUsd: number | null;
}

/**
 * What a provider can do, and what it charges.
 *
 * Declared rather than inferred so a caller can pick, warn or refuse before a
 * job is opened. `estimateUsd` is an estimate: the provider's own invoice stays
 * authoritative, which is why `LessonProgress.costUsd` is separate and may be
 * null — "not priced" and "free" are different facts.
 */
export interface GeneratorCapabilities {
  languages: readonly LessonLanguage[];
  visualStyles: readonly LessonVisualStyle[];
  durationsSeconds: readonly (30 | 60)[];
  /** Whether this provider can also produce the .pptx for the same scenes. */
  producesPptx: boolean;
  /** Whether a GPU must be reachable for this provider to accept work. */
  requiresGpu: boolean;
  estimateUsd(request: LessonRequest): number | null;
}

export interface LessonGenerator {
  readonly id: string;
  readonly capabilities: GeneratorCapabilities;
  reserve(request: LessonRequest): Promise<ReservedLesson>;
  status(lessonId: string): Promise<LessonProgress>;
  cancel(lessonId: string): Promise<void>;
}

/** Why a provider cannot take a request. Null when it can. */
export function unsupportedReason(
  capabilities: GeneratorCapabilities,
  request: LessonRequest,
): string | null {
  if (!capabilities.languages.includes(request.language)) {
    return `This provider does not speak ${request.language}.`;
  }
  if (!capabilities.visualStyles.includes(request.visualStyle)) {
    return `This provider has no ${request.visualStyle} style.`;
  }
  if (!capabilities.durationsSeconds.includes(request.durationSeconds)) {
    return `This provider does not make ${request.durationSeconds}-second lessons.`;
  }
  return null;
}
