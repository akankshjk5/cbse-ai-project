import 'server-only';

/**
 * What happens between a teacher pressing the button and work being queued.
 *
 * The order here is the whole point. The atomic reservation runs FIRST, and
 * the output planning runs against what it returned. Doing it the other way —
 * look up a compatible lesson, decide, then insert — is the race the database
 * function exists to prevent: two teachers asking at once would both find
 * nothing, both decide to generate, and both insert.
 *
 * So the application never decides whether a lesson exists. It asks the
 * database to reserve one, and then asks what that reservation came back with.
 */

import { createClient } from '@/lib/supabase/server';
import {
  type OutputKind,
  type ReusePlan,
  type SourceCost,
  planOutputs,
  reuseEvent,
  savingsFor,
} from './outputs';
import type { CompatibilityKey, SourceLesson } from './reuse';

export interface LessonRequest {
  classLevel: number;
  subject: string;
  topic: string;
  languageCode: string;
  durationSeconds: 30 | 60;
  visualStyle: string;
  chapter?: string | null;
  difficulty?: string;
  requestedOutputs: OutputKind[];
}

export interface AdmittedLesson {
  projectId: string;
  status: string;
  /** The project this reservation copied visuals from, if any. */
  sourceProjectId: string | null;
  /** Outputs that already exist as validated assets on this project. */
  available: OutputKind[];
  /** Outputs still to produce, and the stages each needs. */
  plan: ReusePlan;
  /** True when nothing needs to run: every requested output is already there. */
  servedFromCache: boolean;
}

/**
 * Reserve, then plan.
 *
 * `reserve_cloud_lesson` is unchanged and still the only thing that decides
 * whether a project row is created. It serialises on an advisory lock and a
 * unique `(school_id, content_key)`, so eight simultaneous identical requests
 * produce one project and one prepare job — verified against PostgreSQL rather
 * than assumed.
 */
export async function admitLessonRequest(request: LessonRequest): Promise<AdmittedLesson> {
  const client = await createClient();

  const { data, error } = await client.rpc('reserve_cloud_lesson', {
    p_class_level: request.classLevel,
    p_subject: request.subject,
    p_topic: request.topic,
    p_language_code: request.languageCode,
    p_target_duration_seconds: request.durationSeconds,
    p_visual_style: request.visualStyle,
  });
  if (error) throw error;

  const project = data?.[0];
  if (!project) throw new Error('reserve_cloud_lesson returned no project');

  // The RPC predates requested outputs, so the request's own choice is written
  // once onto the row it produced. A reservation that joined an existing job
  // keeps that job's outputs: the first asker decides what gets built, and a
  // later asker for a subset is served from it rather than widening the work.
  const wanted = normalise(request.requestedOutputs);
  if (project.status !== 'succeeded') {
    const { error: updateError } = await client
      .from('cloud_lesson_projects')
      .update({ requested_outputs: wanted })
      .eq('id', project.id)
      // Only widen a request that has not started producing. Narrowing one
      // mid-flight would orphan work already queued.
      .in('status', ['preparing'])
      .select('id');
    if (updateError) throw updateError;
  }

  const available = await availableOutputs(client, project.id);
  const source = project.reused_from_project_id
    ? await loadSource(client, project.reused_from_project_id)
    : null;

  const plan = planOutputs(
    { key: compatibilityKeyOf(request, project), outputs: wanted },
    source,
  );

  return {
    projectId: project.id,
    status: project.status,
    sourceProjectId: project.reused_from_project_id ?? null,
    available,
    plan,
    // Nothing to run and everything asked for is present.
    servedFromCache: plan.stages.length === 0
      && wanted.every((kind) => available.includes(kind)),
  };
}

/** Writes the audit row. Called after admission, never instead of it. */
export async function recordReuse(
  admitted: AdmittedLesson,
  cost: SourceCost | null,
  reusedAssetIds: readonly string[] = [],
): Promise<void> {
  if (admitted.plan.decision === 'miss' && !admitted.sourceProjectId) return;
  const client = await createClient();
  const savings = savingsFor(admitted.plan, cost);
  const event = reuseEvent({
    requestedBy: '',            // read from the project inside the function
    projectId: admitted.projectId,
    sourceProjectId: admitted.sourceProjectId,
    schoolId: null,             // likewise
    plan: admitted.plan,
    savings,
    reusedAssetIds,
  });
  const { error } = await client.rpc('record_lesson_reuse', {
    p_project_id: event.projectId,
    p_source_project_id: event.sourceProjectId,
    p_decision: event.decision,
    p_satisfied: event.satisfiedOutputs,
    p_generated: event.generatedOutputs,
    p_reused_asset_ids: event.reusedAssetIds,
    p_savings_usd: event.savingsUsd,
    p_savings_basis: event.savingsBasis,
    p_savings_gpu_seconds: event.savingsGpuSeconds,
    p_rationale: event.rationale,
  });
  if (error) throw error;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof createClient>>;

async function availableOutputs(client: Client, projectId: string): Promise<OutputKind[]> {
  const { data, error } = await client.rpc('lesson_available_outputs', { p_project_id: projectId });
  if (error) throw error;
  return normalise((data ?? []) as OutputKind[]);
}

/**
 * The source lesson, shaped for `evaluateReuse`.
 *
 * Read through the same RLS the requesting teacher has, so a source they may
 * not see cannot be matched against. Nothing about the source's owner is
 * selected: the audit knows which project was reused, the teacher does not.
 */
async function loadSource(client: Client, sourceId: string): Promise<{
  lesson: SourceLesson; available: OutputKind[];
} | null> {
  const { data, error } = await client
    .from('cloud_lesson_projects')
    // One string literal, deliberately: supabase-js reads the select list at
    // the type level, and a concatenation widens to `string`, which types the
    // whole row as an error object.
    .select('id, status, completed_at, class_level, subject, chapter, topic, language_code, difficulty, target_duration_seconds, visual_style, content_version, generator_version, model_versions, curriculum_version')
    .eq('id', sourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: scenes, error: sceneError } = await client
    .from('cloud_lesson_scenes')
    .select('scene_index, status, image_url, motion_mode, video_url')
    .eq('project_id', sourceId)
    .order('scene_index');
  if (sceneError) throw sceneError;

  const expected = Math.round(data.target_duration_seconds / 7.5);
  return {
    lesson: {
      lessonId: data.id,
      key: {
        curriculum: data.curriculum_version ?? 'KTBS',
        classLevel: data.class_level,
        subject: data.subject,
        chapter: data.chapter ?? null,
        topic: data.topic,
        language: data.language_code,
        difficulty: data.difficulty ?? 'standard',
        durationSeconds: data.target_duration_seconds,
        visualStyle: data.visual_style,
        contentVersion: data.content_version ?? '1.0.0',
        pipelineVersion: data.generator_version ?? 'v1',
        modelVersions: (data.model_versions ?? {}) as Record<string, string>,
      },
      status: data.status,
      completedAt: data.completed_at,
      // The prepare stage records its own validation; a source whose plan was
      // never validated is not reusable regardless of how complete it looks.
      planValidated: data.status === 'succeeded',
      sceneCount: scenes?.length ?? 0,
      expectedSceneCount: expected,
      scenes: (scenes ?? []).map((scene) => ({
        sceneIndex: scene.scene_index,
        status: scene.status,
        imageUrl: scene.image_url,
        motionMode: scene.motion_mode === 'animate' ? 'animate' as const : 'still' as const,
        rawVideoUrl: scene.video_url,
      })),
    },
    available: await availableOutputs(client, sourceId),
  };
}

/**
 * Just the dimensions a compatibility key needs.
 *
 * Indexed rather than declared field-by-field because the reservation RPC's
 * generated return type is narrower than the table row, and the two must both
 * be acceptable here.
 */
type VersionColumns = Record<string, unknown>;

function str(row: VersionColumns, key: string, fallback: string): string {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function compatibilityKeyOf(
  request: LessonRequest,
  project: VersionColumns,
): CompatibilityKey {
  return {
    curriculum: str(project, 'curriculum_version', 'KTBS'),
    classLevel: request.classLevel,
    subject: request.subject,
    chapter: request.chapter ?? null,
    topic: request.topic,
    language: request.languageCode,
    difficulty: request.difficulty ?? 'standard',
    durationSeconds: request.durationSeconds,
    visualStyle: request.visualStyle,
    contentVersion: str(project, 'content_version', '1.0.0'),
    pipelineVersion: str(project, 'generator_version', 'v1'),
    modelVersions: (project.model_versions ?? {}) as Record<string, string>,
  };
}

/** Stable order and no repeats, so two equal requests compare equal. */
function normalise(kinds: readonly OutputKind[]): OutputKind[] {
  return (['video', 'pptx'] as const).filter((kind) => kinds.includes(kind));
}
