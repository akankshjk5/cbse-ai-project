import assert from 'node:assert/strict';
import { cloudLessonKeys, cloudLessonProgress } from '../src/lib/cloud-lesson/progress.ts';
import { cloudLessonApiError } from '../src/lib/cloud-lesson/api-errors.ts';
import { formatCloudLessonReport, summarizeCloudLesson } from '../src/lib/cloud-lesson/report.ts';
import {
  CLOUD_LESSON_JOB_PUBLIC_COLUMNS,
  CLOUD_LESSON_STYLE_COPY,
  CLOUD_LESSON_VISUAL_STYLES,
  CloudLessonJobKindSchema,
  CloudLessonJobProgressSchema,
  CreateCloudLessonSchema,
  cloudLessonAnimationCap,
  cloudLessonPictureCount,
  cloudLessonStorybookEstimateUsd,
  deckUrlFor,
  type CloudLessonJobProgress,
  type CloudLessonProject,
} from '../src/lib/videos/cloud-lesson-contracts.ts';
const base = { target_duration_seconds: 60, status: 'preparing', reused_from_project_id: null } as CloudLessonProject;
const job = (kind: CloudLessonJobProgress['kind'], status = 'succeeded', progress = 100) => ({ kind, status, progress } as CloudLessonJobProgress);
const input = { classLevel: 6, subject: ' SCIENCE ', topic: 'Water   cycle', languageCode: 'en-IN' };
assert.deepEqual(cloudLessonKeys(input), { contentKey: '6|science|water cycle|60', cacheKey: '6|science|water cycle|60|en-IN' });
assert.notEqual(cloudLessonKeys(input).cacheKey, cloudLessonKeys({ ...input, languageCode: 'hi-IN' }).cacheKey);
assert.notEqual(cloudLessonKeys(input).cacheKey, cloudLessonKeys({ ...input, durationSeconds: 30 }).cacheKey);
assert.equal(CreateCloudLessonSchema.parse(input).visualStyle, 'illustrated');
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, durationSeconds: 45 }).success, false);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, visualStyle: 'unknown' }).success, false);
const short = cloudLessonProgress({ ...base, target_duration_seconds: 30, status: 'generating_videos' },
  [job('prepare'), ...Array.from({ length: 4 }, () => job('image'))]);
assert.equal(short.progress, 50);
assert.equal(short.stages[1].total, 4);
assert.equal(cloudLessonProgress(base, []).progress, 0);
assert.equal(cloudLessonProgress(base, []).waitingForWorker, true);
assert.equal(cloudLessonProgress(base, [job('prepare', 'processing', 50)]).progress, 10);
assert.equal(cloudLessonProgress(base, [job('prepare', 'processing', 50)]).waitingForWorker, false);
const finished = [job('prepare'), ...Array.from({ length: 8 }, () => job('image')),
  ...Array.from({ length: 8 }, () => job('video')), job('assemble')];
assert.equal(cloudLessonProgress({ ...base, status: 'assembling' }, finished).progress, 99);
assert.equal(cloudLessonProgress({ ...base, status: 'succeeded' }, finished).progress, 100);
assert.equal(cloudLessonProgress({ ...base, status: 'cancelled' }, []).waitingForWorker, false);
const reused = cloudLessonProgress({ ...base, status: 'generating_videos', reused_from_project_id: 'source' }, [job('prepare')]);
assert.equal(reused.progress, 50); assert.equal(reused.stages[1].count, 8);
assert.equal(reused.stages[1].completed, true);
for (const [hint, status] of [['cloud_lesson_auth', 401], ['cloud_lesson_invalid', 400],
  ['cloud_lesson_active_limit', 429], ['cloud_lesson_daily_limit', 429]] as const) {
  const response = cloudLessonApiError({ hint, message: 'private provider details' });
  assert.equal(response.status, status); assert.ok(!(await response.text()).includes('private'));
}
assert.equal(cloudLessonApiError(new SyntaxError()).status, 400);
assert.equal(cloudLessonApiError(new Response('Unauthorized', { status: 401 })).status, 401);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, classLevel: 13 }).success, false);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, languageCode: 'fr-FR' }).success, false);
// Storybook (S7): offered to teachers, counted per picture, priced from measured costs.
assert.equal(CreateCloudLessonSchema.parse({ ...input, visualStyle: 'storybook' }).visualStyle, 'storybook');
for (const style of CLOUD_LESSON_VISUAL_STYLES) assert.ok(CLOUD_LESSON_STYLE_COPY[style].label && CLOUD_LESSON_STYLE_COPY[style].description);
assert.deepEqual([cloudLessonAnimationCap('storybook', 30), cloudLessonAnimationCap('storybook', 60)], [1, 2]);
assert.deepEqual([cloudLessonAnimationCap('illustrated', 30), cloudLessonAnimationCap('illustrated', 60)], [2, 3]);
assert.deepEqual([cloudLessonAnimationCap('editorial', 30), cloudLessonAnimationCap('editorial', 60)], [4, 6]);
assert.deepEqual([cloudLessonPictureCount('storybook', 30), cloudLessonPictureCount('storybook', 60), cloudLessonPictureCount('illustrated', 60)], [8, 16, 8]);
const estimate30 = cloudLessonStorybookEstimateUsd(30, .035); const estimate60 = cloudLessonStorybookEstimateUsd(60, .035);
assert.ok(estimate30 > .6 && estimate30 < .8, `30 s storybook estimate ${estimate30}`);
assert.ok(estimate60 > 1.2 && estimate60 < 1.5, `60 s storybook estimate ${estimate60}`);
const story = { ...base, target_duration_seconds: 30, visual_style: 'storybook', status: 'generating_images' } as CloudLessonProject;
const firstOnly = cloudLessonProgress(story, [job('prepare'), job('image', 'processing', 50), ...Array.from({ length: 7 }, () => job('image', 'queued', 0))]);
assert.equal(firstOnly.stages[1].label, 'Storybook pictures'); assert.equal(firstOnly.stages[1].total, 8); assert.equal(firstOnly.stages[1].count, 0);
assert.equal(firstOnly.waitingForWorker, false);
const halfDrawn = cloudLessonProgress(story, [job('prepare'), ...Array.from({ length: 4 }, () => job('image')), ...Array.from({ length: 4 }, () => job('image', 'queued', 0))]);
assert.equal(halfDrawn.progress, 35); assert.equal(halfDrawn.stages[1].count, 4); assert.equal(halfDrawn.stages[1].completed, false);
const drawn = cloudLessonProgress({ ...story, status: 'generating_videos' }, [job('prepare'), ...Array.from({ length: 8 }, () => job('image'))]);
assert.equal(drawn.progress, 50); assert.equal(drawn.stages[1].completed, true); assert.equal(drawn.stages[2].total, 4);
const reusedStory = cloudLessonProgress({ ...story, status: 'generating_videos', reused_from_project_id: 'source' }, [job('prepare')]);
assert.equal(reusedStory.stages[1].label, 'Reusing storybook pictures'); assert.equal(reusedStory.stages[1].count, 8);
assert.equal(reusedStory.progress, 50);
const threeShots = cloudLessonProgress(story, [job('prepare'), ...Array.from({ length: 12 }, () => job('image'))]);
assert.equal(threeShots.stages[1].total, 12, 'an older three-shot plan is counted by its jobs');
// S8: the read-only lesson report sums the stored queue, never re-estimating what was recorded.
const at = (m: number) => new Date(Date.UTC(2026, 9, 11, 12, m)).toISOString();
const reportProject = { id: 'p', title: 'The escape', topic: 't', status: 'succeeded', visual_style: 'storybook' as const, target_duration_seconds: 30,
  language_code: 'en-IN', cost_usd: '0.7', created_at: at(0), completed_at: at(8), reused_from_project_id: null };
const reportJobs = [
  { kind: 'prepare', status: 'succeeded', attempts: 1, cost_usd: '0.04', started_at: at(0), completed_at: at(1), output_metadata: {} },
  ...Array.from({ length: 8 }, (_, i) => ({ kind: 'image', status: 'succeeded', attempts: i === 3 ? 2 : 1, cost_usd: 0.061, started_at: at(1), completed_at: at(i ? 4 : 2), output_metadata: {} })),
  { kind: 'video', status: 'succeeded', attempts: 1, cost_usd: 0.175, started_at: at(2), completed_at: at(6), output_metadata: { provider: 'higgsfield', costIsEstimate: true } },
  ...Array.from({ length: 3 }, () => ({ kind: 'video', status: 'succeeded', attempts: 1, cost_usd: 0, started_at: at(4), completed_at: at(5), output_metadata: {} })),
  { kind: 'assemble', status: 'succeeded', attempts: 1, cost_usd: 0, started_at: at(6), completed_at: at(7), output_metadata: { music: true } },
];
const lessonReport = summarizeCloudLesson(reportProject, reportJobs, .035);
assert.equal(lessonReport.stages[1].jobs, 8); assert.equal(lessonReport.stages[1].retries, 1); assert.equal(lessonReport.stages[1].costUsd, .488);
assert.equal(lessonReport.stages[1].spanSeconds, 180); assert.equal(lessonReport.totalUsd, .703);
assert.equal(lessonReport.animatedScenes, 1); assert.equal(lessonReport.animationCostIsEstimate, true);
assert.equal(lessonReport.wallSeconds, 480); assert.ok(lessonReport.storybookEstimateUsd! > .6);
assert.ok(formatCloudLessonReport(reportProject, lessonReport).includes('start to finish  8m 00s'));
assert.equal(summarizeCloudLesson({ ...reportProject, visual_style: 'illustrated' }, [], .035).storybookEstimateUsd, null);
assert.equal(summarizeCloudLesson({ ...reportProject, completed_at: null }, [], .035).wallSeconds, null);
// ── The client's job kinds must be the database's job kinds ───────────────
//
// 20261019140000 added 'deck' to the kind CHECK on cloud_lesson_jobs and
// CloudLessonJobKindSchema was not updated. loadCloudLesson parses every job
// row through it, so the first lesson with a deck job made
// GET /api/cloud-lessons/{id} throw, and a teacher saw an error instead of
// their lesson. Nothing caught it: the enum and the constraint live in
// different languages and no test had ever compared them.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = 'supabase/migrations';
  // The LAST migration that redefines the constraint is the one in force.
  let allowed: string[] | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const match of sql.matchAll(
      /constraint\s+cloud_lesson_jobs_kind_check\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\)/gi)) {
      allowed = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    }
    for (const match of sql.matchAll(
      /check\s*\(\s*kind\s+in\s*\(([^)]*)\)\s*\)/gi)) {
      if (/cloud_lesson_jobs/.test(sql)) {
        allowed = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      }
    }
  }

  assert.ok(allowed && allowed.length >= 4,
    `could not read the job-kind constraint out of ${dir}; the scan is broken`);
  const fromDb = [...allowed!].sort();
  const fromClient = [...CloudLessonJobKindSchema.options].sort();
  assert.deepEqual(
    fromClient, fromDb,
    `the client accepts [${fromClient}] but the database allows [${fromDb}]. `
    + 'A kind the client does not know makes loadCloudLesson throw for every '
    + 'lesson that has one.');
  console.log(`Cloud UI contracts: job kinds agree with the database (${fromDb.join(', ')}).`);
}

// Every field the schema requires must be a column the query selects.
//
// loadCloudLesson does `.select(CLOUD_LESSON_JOB_PUBLIC_COLUMNS)` and then
// parses the rows with CloudLessonJobProgressSchema. A field in the schema but
// not in the string comes back absent, and the parse throws for every lesson
// -- the same shape of failure as the deck-kind drift above, through a
// different crack. Mutation-tested: removing output_url from the string fails
// this and nothing else.
{
  const selected = new Set(
    CLOUD_LESSON_JOB_PUBLIC_COLUMNS.split(',').map((column) => column.trim()));
  const required = Object.keys(CloudLessonJobProgressSchema.shape);
  assert.ok(required.length > 5, 'the schema shape could not be read');
  for (const field of required) {
    assert.ok(selected.has(field),
      `CloudLessonJobProgressSchema requires "${field}" but `
      + `CLOUD_LESSON_JOB_PUBLIC_COLUMNS does not select it, so every job row `
      + `would fail to parse`);
  }
  console.log(`Cloud UI contracts: all ${required.length} job fields are selected by the query.`);
}

// deckUrlFor is the single answer to "is there a deck, and where".
{
  const base = {
    id: '11111111-1111-4111-8111-111111111111', scene_id: null,
    progress: 100, attempts: 1, max_attempts: 2,
    started_at: null, completed_at: null, error_message: null,
  } as const;
  const url = 'https://example.test/lesson.pptx';

  assert.equal(deckUrlFor([]), null, 'no jobs means no deck');
  assert.equal(
    deckUrlFor([{ ...base, kind: 'assemble', status: 'succeeded', output_url: url }]),
    null, 'an assembled VIDEO must not be offered as a deck');
  assert.equal(
    deckUrlFor([{ ...base, kind: 'deck', status: 'processing', output_url: null }]),
    null, 'a deck still being built is not a deck');
  assert.equal(
    deckUrlFor([{ ...base, kind: 'deck', status: 'failed', output_url: null }]),
    null, 'a failed deck is not a deck');
  assert.equal(
    deckUrlFor([{ ...base, kind: 'deck', status: 'succeeded', output_url: null }]),
    null, 'a succeeded deck with no URL is not downloadable, so it is not offered');
  assert.equal(
    deckUrlFor([{ ...base, kind: 'deck', status: 'succeeded', output_url: url }]),
    url, 'a finished deck must be reachable');
  console.log('Cloud UI contracts: deckUrlFor offers only a finished, downloadable deck.');
}

console.log('Cloud UI contracts: cache keys, all progress states, reuse progress, request validation, safe refusal messages, storybook and the lesson report passed.');
