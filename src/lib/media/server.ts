import 'server-only';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { publicEnv } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

export async function authenticatedMediaClient() {
  const userId = await requireUserIdOrThrow();
  return { userId, supabase: await createClient() };
}

export const MEDIA_JOB_PUBLIC_COLUMNS = [
  'id', 'owner_id', 'deck_id', 'video_project_id', 'slide_id', 'target_block', 'kind', 'profile',
  'status', 'prompt', 'negative_prompt', 'source_image_url', 'parameters',
  'progress', 'attempts', 'max_attempts', 'output_url', 'output_metadata',
  'error_code', 'error_message', 'cancel_requested_at', 'created_at',
  'updated_at', 'started_at', 'completed_at',
].join(',');

export function isAllowedMediaSourceUrl(value: string): boolean {
  try {
    const source = new URL(value);
    const storageHost = new URL(publicEnv.supabaseUrl).hostname;
    return source.protocol === 'https:' && source.hostname === storageHost;
  } catch {
    return false;
  }
}
