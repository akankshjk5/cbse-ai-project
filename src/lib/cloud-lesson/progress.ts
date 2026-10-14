import { cloudLessonPictureCount, type CloudLessonProject, type CloudLessonJobProgress } from '@/lib/videos/cloud-lesson-contracts';

export function cloudLessonProgress(project: CloudLessonProject, jobs: CloudLessonJobProgress[]) {
  const value = (kind: string, count: number) => Math.min(1, jobs.filter(j => j.kind === kind)
    .reduce((sum, j) => sum + (j.status === 'succeeded' ? 1 : Math.min(99, j.progress) / 100), 0) / count);
  const count = project.target_duration_seconds / 7.5;
  // A storybook lesson draws two pictures a scene; older plans may have three, so trust the jobs when there are more.
  const storybook = project.visual_style === 'storybook';
  const pictures = Math.max(cloudLessonPictureCount(project.visual_style, project.target_duration_seconds),
    jobs.filter(j => j.kind === 'image').length);
  const reused = !!project.reused_from_project_id;
  const progress = project.status === 'succeeded' ? 100 : Math.min(99, Math.round(
    value('prepare', 1) * 20 + (reused && project.status !== 'preparing' ? 30 : value('image', pictures) * 30)
      + value('video', count) * 40 + value('assemble', 1) * 10));
  const processing = jobs.some(j => j.status === 'processing');
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(project.status);
  return { progress, waitingForWorker: !terminal && !processing,
    stages: [
      { key: 'prepare', label: 'Script and narration', completed: jobs.some(j => j.kind === 'prepare' && j.status === 'succeeded'), count: jobs.filter(j => j.kind === 'prepare' && j.status === 'succeeded').length, total: 1 },
      { key: 'image', label: storybook ? (reused ? 'Reusing storybook pictures' : 'Storybook pictures') : reused ? 'Reusing lesson images' : 'Lesson images', completed: reused ? project.status !== 'preparing' : value('image', pictures) === 1, count: reused && project.status !== 'preparing' ? pictures : jobs.filter(j => j.kind === 'image' && j.status === 'succeeded').length, total: pictures },
      { key: 'video', label: reused ? 'New captions and scenes' : 'Animation and scenes', completed: value('video', count) === 1, count: jobs.filter(j => j.kind === 'video' && j.status === 'succeeded').length, total: count },
      { key: 'assemble', label: 'Final video', completed: value('assemble', 1) === 1, count: jobs.filter(j => j.kind === 'assemble' && j.status === 'succeeded').length, total: 1 },
    ] };
}
export function cloudLessonKeys(input: { classLevel: number; subject: string; topic: string; languageCode: string; durationSeconds?: 30 | 60; visualStyle?: string }) {
  const clean = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const contentKey = `${input.classLevel}|${clean(input.subject)}|${clean(input.topic)}|${input.durationSeconds ?? 60}`;
  return { contentKey, cacheKey: `${contentKey}|${input.languageCode}` };
}
