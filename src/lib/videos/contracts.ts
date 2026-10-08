import { z } from 'zod';

export const VIDEO_SUBJECTS = [
  'Mathematics',
  'Science',
  'Social Science',
  'English',
  'Hindi',
  'EVS',
  'Computer Science',
] as const;

export const VIDEO_DURATIONS = [3, 5] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const CreateVideoProjectSchema = z.object({
  classLevel: z.number().int().min(1).max(12),
  subject: z.string().trim().min(2).max(100),
  topic: z.string().trim().min(3).max(300),
  durationSeconds: z.union([z.literal(3), z.literal(5)]).default(3),
});

export const VideoProjectStatusSchema = z.enum([
  'generating_image',
  'generating_video',
  'succeeded',
  'failed',
  'cancelled',
]);

export const VideoProjectSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string(),
  class_level: z.number().int(),
  subject: z.string(),
  topic: z.string(),
  duration_seconds: z.union([z.literal(3), z.literal(5)]),
  image_prompt: z.string(),
  video_prompt: z.string(),
  status: VideoProjectStatusSchema,
  image_job_id: z.string().uuid().nullable(),
  video_job_id: z.string().uuid().nullable(),
  image_url: z.string().nullable(),
  video_url: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export type VideoProject = z.infer<typeof VideoProjectSchema>;
