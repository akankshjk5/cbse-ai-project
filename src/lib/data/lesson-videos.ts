import 'server-only';

import { createClient } from '@/lib/supabase/server';
import {
  LessonVideoProjectSchema,
  type LessonVideoProject,
} from '@/lib/videos/lesson-contracts';

export async function listLessonVideoProjects(
  userId: string,
  limit = 20,
): Promise<LessonVideoProject[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('lesson_video_projects')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));
  if (error) throw new Error(`listLessonVideoProjects failed: ${error.message}`);
  return LessonVideoProjectSchema.array().parse(data ?? []);
}
