import { z } from 'zod';

export const MediaKindSchema = z.enum(['image', 'video']);
export const MediaProfileSchema = z.enum(['image-fast', 'video-fast']);
export const MediaJobStatusSchema = z.enum([
  'queued',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);

export const MODEL_PROFILES = {
  'image-fast': {
    kind: 'image',
    model: 'z-image-turbo-bf16',
    label: 'Fast image',
  },
  'video-fast': {
    kind: 'video',
    model: 'wan-2.2-ti2v-5b-fp16',
    label: 'Fast video',
  },
} as const;

export const MEDIA_PROFILE_PARAMETERS = {
  'image-fast': { width: 1024, height: 576, steps: 8 },
  // 20 steps is the optimized target from ComfyUI's native graph. Set
  // WAN_FAST_STEPS=30 on the worker for the already benchmarked fallback.
  'video-fast': { width: 832, height: 480, durationSeconds: 3, fps: 16, steps: 20 },
} as const;

export function resolveMediaParameters(
  profile: z.infer<typeof MediaProfileSchema>,
  requested: { seed?: number },
) {
  return {
    ...MEDIA_PROFILE_PARAMETERS[profile],
    ...(requested.seed === undefined ? {} : { seed: requested.seed }),
  };
}

const httpUrl = z.string().url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://'),
  'Expected an HTTP(S) URL',
);

export const CreateMediaJobSchema = z.object({
  deckId: z.string().uuid(),
  slideId: z.string().uuid().optional(),
  targetBlock: z.number().int().min(0).max(100).optional(),
  kind: MediaKindSchema,
  profile: MediaProfileSchema,
  prompt: z.string().trim().min(3).max(4000),
  negativePrompt: z.string().trim().max(2000).default(''),
  sourceImageUrl: httpUrl.optional(),
  parameters: z.object({
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  }).strict().default({}),
}).superRefine((value, ctx) => {
  const expected = MODEL_PROFILES[value.profile].kind;
  if (value.kind !== expected) {
    ctx.addIssue({ code: 'custom', path: ['profile'], message: `${value.profile} is ${expected}` });
  }
  if (value.kind === 'video' && !value.sourceImageUrl) {
    ctx.addIssue({ code: 'custom', path: ['sourceImageUrl'], message: 'Video needs a source image' });
  }
});

export const MediaJobSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string(),
  deck_id: z.string().uuid().nullable(),
  video_project_id: z.string().uuid().nullable(),
  slide_id: z.string().uuid().nullable(),
  target_block: z.number().int().nullable(),
  kind: MediaKindSchema,
  profile: MediaProfileSchema,
  status: MediaJobStatusSchema,
  prompt: z.string(),
  negative_prompt: z.string(),
  source_image_url: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()),
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().min(0),
  max_attempts: z.number().int().min(1),
  output_url: z.string().nullable(),
  output_metadata: z.record(z.string(), z.unknown()),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  cancel_requested_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export type CreateMediaJobInput = z.input<typeof CreateMediaJobSchema>;
export type MediaJob = z.infer<typeof MediaJobSchema>;
