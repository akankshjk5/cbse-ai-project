import 'server-only';

import { createClient } from '@/lib/supabase/server';
import type { VideoProject } from '@/lib/supabase/types';

export async function listVideoProjects(userId: string, limit = 20): Promise<VideoProject[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('video_projects')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));
  if (error) throw new Error(`listVideoProjects failed: ${error.message}`);
  return data ?? [];
}
