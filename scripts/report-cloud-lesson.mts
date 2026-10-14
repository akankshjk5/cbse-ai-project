/**
 * READ-ONLY report of one cloud lesson's real cost and time, from the queue.
 * Makes no model calls and writes nothing.
 *
 *   npm run report:cloud-lesson -- <lesson-id>
 *   npm run report:cloud-lesson -- --latest [--style storybook]
 */
import { createAdminClient } from '../src/lib/supabase/admin.ts';
import { formatCloudLessonReport, summarizeCloudLesson } from '../src/lib/cloud-lesson/report.ts';
import { serverEnv } from '../src/lib/env.ts';

const args = process.argv.slice(2);
const style = args.includes('--style') ? args[args.indexOf('--style') + 1] : undefined;
const id = args.find(a => /^[0-9a-f-]{36}$/i.test(a));
if (!id && !args.includes('--latest')) {
  console.log('Usage: npm run report:cloud-lesson -- <lesson-id> | --latest [--style storybook]');
} else {
  const client = createAdminClient();
  let query = client.from('cloud_lesson_projects')
    .select('id,title,topic,status,visual_style,target_duration_seconds,language_code,cost_usd,created_at,completed_at,reused_from_project_id');
  if (id) query = query.eq('id', id);
  if (!id && style) query = query.eq('visual_style', style);
  const { data: projects, error } = await query.order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error('Could not load the lesson.');
  const project = projects?.[0];
  if (!project) {
    console.log('No matching lesson.');
  } else {
    const { data: jobs, error: jobError } = await client.from('cloud_lesson_jobs')
      .select('kind,status,attempts,cost_usd,started_at,completed_at,output_metadata').eq('project_id', project.id);
    if (jobError) throw new Error('Could not load the lesson jobs.');
    const report = summarizeCloudLesson(project, jobs ?? [], serverEnv.cloudLessonHiggsfieldUsdPerSecond);
    console.log(formatCloudLessonReport(project, report));
  }
}
