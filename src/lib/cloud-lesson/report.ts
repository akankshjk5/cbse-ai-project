import { cloudLessonStorybookEstimateUsd, type CloudLessonStoredVisualStyle } from '@/lib/videos/cloud-lesson-contracts';

/**
 * What one finished (or failed) cloud lesson actually cost and how long it
 * took, from its stored rows. Pure, so it is tested offline; the
 * `report:cloud-lesson` script feeds it rows read with the service role.
 */
export interface ReportProject {
  id: string; title: string | null; topic: string; status: string; visual_style?: CloudLessonStoredVisualStyle | null;
  target_duration_seconds: number; language_code: string; cost_usd: number | string;
  created_at: string; completed_at: string | null; reused_from_project_id: string | null;
}
export interface ReportJob {
  kind: string; status: string; attempts: number; cost_usd: number | string;
  started_at: string | null; completed_at: string | null; output_metadata: unknown;
}
export interface StageReport { kind: string; jobs: number; succeeded: number; retries: number; costUsd: number; workerSeconds: number; spanSeconds: number }
export interface LessonReport {
  stages: StageReport[]; totalUsd: number; recordedProjectUsd: number; wallSeconds: number | null;
  animatedScenes: number; animationCostIsEstimate: boolean; storybookEstimateUsd: number | null;
}

const KINDS = ['prepare', 'image', 'video', 'assemble'] as const;
const seconds = (from: string | null, to: string | null) =>
  from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : 0;
const metadata = (job: ReportJob) =>
  job.output_metadata && typeof job.output_metadata === 'object' && !Array.isArray(job.output_metadata)
    ? job.output_metadata as Record<string, unknown> : {};

export function summarizeCloudLesson(project: ReportProject, jobs: ReportJob[], usdPerAnimationSecond: number): LessonReport {
  const stages = KINDS.map((kind): StageReport => {
    const rows = jobs.filter(j => j.kind === kind);
    const starts = rows.map(j => j.started_at).filter((v): v is string => !!v).sort();
    const ends = rows.map(j => j.completed_at).filter((v): v is string => !!v).sort();
    return {
      kind, jobs: rows.length, succeeded: rows.filter(j => j.status === 'succeeded').length,
      retries: rows.reduce((sum, j) => sum + Math.max(0, j.attempts - 1), 0),
      costUsd: Math.round(rows.reduce((sum, j) => sum + Number(j.cost_usd), 0) * 1e6) / 1e6,
      workerSeconds: Math.round(rows.reduce((sum, j) => sum + seconds(j.started_at, j.completed_at), 0)),
      spanSeconds: Math.round(seconds(starts[0] ?? null, ends.at(-1) ?? null)),
    };
  });
  const videos = jobs.filter(j => j.kind === 'video' && j.status === 'succeeded');
  const duration = project.target_duration_seconds === 30 ? 30 : 60;
  return {
    stages,
    totalUsd: Math.round(stages.reduce((sum, s) => sum + s.costUsd, 0) * 1e6) / 1e6,
    recordedProjectUsd: Number(project.cost_usd),
    wallSeconds: project.completed_at ? Math.round(seconds(project.created_at, project.completed_at)) : null,
    animatedScenes: videos.filter(j => metadata(j).provider === 'higgsfield').length,
    animationCostIsEstimate: videos.some(j => metadata(j).costIsEstimate === true),
    storybookEstimateUsd: project.visual_style === 'storybook' && !project.reused_from_project_id
      ? Math.round(cloudLessonStorybookEstimateUsd(duration, usdPerAnimationSecond) * 1e4) / 1e4 : null,
  };
}

const minutes = (value: number) => `${Math.floor(value / 60)}m ${String(Math.round(value % 60)).padStart(2, '0')}s`;

export function formatCloudLessonReport(project: ReportProject, report: LessonReport): string {
  const lines = [
    `${project.title ?? project.topic}  (${project.id})`,
    `${project.visual_style ?? 'editorial'} · ${project.target_duration_seconds} s · ${project.language_code} · ${project.status}`
      + (project.reused_from_project_id ? ' · visuals reused' : ''),
    '',
    'stage      jobs  done  retries      cost   worker time   first start → last finish',
  ];
  for (const s of report.stages) {
    lines.push(`${s.kind.padEnd(9)} ${String(s.jobs).padStart(5)} ${String(s.succeeded).padStart(5)} ${String(s.retries).padStart(8)}`
      + `  $${s.costUsd.toFixed(4).padStart(7)}  ${minutes(s.workerSeconds).padStart(11)}   ${minutes(s.spanSeconds).padStart(9)}`);
  }
  lines.push('', `total recorded  $${report.totalUsd.toFixed(4)}  (lesson row: $${report.recordedProjectUsd.toFixed(4)})`);
  if (report.storybookEstimateUsd !== null) lines.push(`storybook estimate on the form  $${report.storybookEstimateUsd.toFixed(4)}`);
  lines.push(`animated scenes  ${report.animatedScenes}${report.animationCostIsEstimate ? '  (Higgsfield cost is an estimate: check the invoice)' : ''}`);
  lines.push(`start to finish  ${report.wallSeconds === null ? 'not finished' : minutes(report.wallSeconds)}`);
  return lines.join('\n');
}
