import { z } from 'zod';

import { VIDEO_LANGUAGES } from '@/lib/videos/languages';

export const LESSON_VIDEO_DURATIONS = [60, 90] as const;
export type LessonVideoDuration = (typeof LESSON_VIDEO_DURATIONS)[number];

const languageCodes = VIDEO_LANGUAGES.map((language) => language.code) as [
  (typeof VIDEO_LANGUAGES)[number]['code'],
  ...(typeof VIDEO_LANGUAGES)[number]['code'][],
];

export const CreateLessonVideoSchema = z.object({
  classLevel: z.number().int().min(1).max(12),
  subject: z.string().trim().min(2).max(100),
  topic: z.string().trim().min(3).max(300),
  languageCode: z.enum(languageCodes).default('en-IN'),
  targetDurationSeconds: z.union([z.literal(60), z.literal(90)]).default(60),
});

export const LessonVideoStatusSchema = z.enum([
  'preparing',
  'generating_images',
  'generating_videos',
  'assembling',
  'succeeded',
  'failed',
  'cancelled',
]);

export const LessonVideoSceneSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  scene_index: z.number().int(),
  duration_seconds: z.coerce.number(),
  fact: z.string(),
  narration: z.string(),
  image_prompt: z.string(),
  video_prompt: z.string(),
  caption: z.string().default(''),
  overlay: z.record(z.string(), z.unknown()).default({ kind: 'none' }),
  status: z.enum([
    'queued_image',
    'generating_image',
    'queued_video',
    'generating_video',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  image_url: z.string().nullable(),
  video_url: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export const LessonVideoProjectSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string(),
  class_level: z.number().int(),
  subject: z.string(),
  topic: z.string(),
  language_code: z.enum(languageCodes),
  language_name: z.string(),
  target_duration_seconds: z.union([z.literal(60), z.literal(90)]),
  title: z.string(),
  learning_objective: z.string(),
  narration_text: z.string(),
  narration_url: z.string().nullable(),
  narration_duration_seconds: z.coerce.number().nullable(),
  status: LessonVideoStatusSchema,
  final_video_url: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export type LessonVideoProject = z.infer<typeof LessonVideoProjectSchema>;
export type LessonVideoScene = z.infer<typeof LessonVideoSceneSchema>;

export interface LessonVideoDetail {
  project: LessonVideoProject;
  scenes: LessonVideoScene[];
  progress: number;
  etaSeconds: number | null;
  sceneProgress: Record<string, number>;
  completedClips: number;
  totalClips: number;
  activeSceneIndex: number | null;
  waitingForWorker: boolean;
}
