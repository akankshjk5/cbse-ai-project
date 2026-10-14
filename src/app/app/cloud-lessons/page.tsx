import { Film } from 'lucide-react';
import { requireUserId } from '@/lib/auth/session';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { CloudLessonStudio } from '@/components/videos/cloud-lesson-studio';
import { serverEnv } from '@/lib/env';
import type { CloudLessonProject } from '@/lib/videos/cloud-lesson-contracts';
export const metadata = { title: 'Lesson Video · Lumina' };
export default async function CloudLessonsPage({ searchParams }: { searchParams: Promise<{ lesson?: string }> }) {
  const ownerId = await requireUserId();
  let projects: CloudLessonProject[] = []; let setupError: string | undefined;
  try { projects = await listCloudLessons(ownerId); }
  catch { setupError = 'Cloud lessons could not be loaded. Check that the cloud database migrations are applied and your session is connected.'; }
  const { lesson } = await searchParams;
  return <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8">
    <header><p className="text-xs font-medium uppercase tracking-widest text-indigo-500">Classroom stories</p><h1 className="mt-2 flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><Film className="h-6 w-6" />Lesson Video</h1><p className="mt-2 text-sm text-neutral-500">Turn a chapter topic into a clear, narrated 30- or 60-second lesson.</p></header>
    <CloudLessonStudio initialProjects={projects} initialId={projects.some(p => p.id === lesson) ? lesson : undefined}
      setupError={setupError} animationAllowance={30 * serverEnv.cloudLessonHiggsfieldUsdPerSecond} />
  </div>;
}
