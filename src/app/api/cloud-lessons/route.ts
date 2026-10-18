import { after, NextResponse } from 'next/server';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { CreateCloudLessonSchema, CloudLessonProjectSchema } from '@/lib/videos/cloud-lesson-contracts';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
import { admitGeneration } from '@/lib/generation/admission';
import { admitLessonRequest, recordReuse } from '@/lib/generation/request';
export async function GET() {
  try { const owner = await requireUserIdOrThrow(); return NextResponse.json({ projects: await listCloudLessons(owner) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return cloudLessonApiError(error); }
}
export async function POST(request: Request) {
  try {
    await requireUserIdOrThrow();
    const input = CreateCloudLessonSchema.parse(await request.json());
    // Refuse before reserving: a lesson whose stages this deployment cannot run
    // should fail at the request, not minutes later inside a worker. The
    // factories in src/lib/cloud-lesson/ remain the control over spending.
    const admission = admitGeneration();
    if (!admission.admitted) {
      return NextResponse.json({ error: admission.reason }, { status: 503 });
    }
    // Reserve first, then plan. The reservation is the only thing that decides
    // whether a project exists, because deciding in the application means two
    // simultaneous requests both find nothing and both insert.
    const admitted = await admitLessonRequest({
      classLevel: input.classLevel,
      subject: input.subject,
      topic: input.topic,
      languageCode: input.languageCode,
      durationSeconds: input.durationSeconds,
      visualStyle: input.visualStyle,
      requestedOutputs: input.requestedOutputs,
    });
    // The audit row is written after the response is on its way. A teacher
    // waiting on a lesson should not wait on bookkeeping, and a failed audit
    // write must not fail their request — but it must still be attempted and
    // still be noticed, so it is logged rather than swallowed.
    after(async () => {
      try {
        await recordReuse(admitted, null);
      } catch (auditError) {
        console.error('[cloud-lessons] reuse audit failed', {
          projectId: admitted.projectId, decision: admitted.plan.decision, error: auditError,
        });
      }
    });

    const client = await createClient();
    const { data, error } = await client
      .from('cloud_lesson_projects').select('*').eq('id', admitted.projectId).single();
    if (error) throw error;
    const project = CloudLessonProjectSchema.parse(data);
    return NextResponse.json({
      project,
      cached: admitted.servedFromCache,
      reusedVisuals: !!admitted.sourceProjectId,
      // What the teacher asked for, what already exists, and what each
      // remaining output will cost in stages. A caller can show "found it",
      // "building the deck only" or "generating" without guessing.
      requestedOutputs: input.requestedOutputs,
      availableOutputs: admitted.available,
      outputs: admitted.plan.outputs.map((output) => ({
        kind: output.kind, disposition: output.disposition, reason: output.reason,
      })),
      decision: admitted.plan.decision,
      decisionVersion: admitted.plan.decisionVersion,
      stages: admitted.plan.stages,
      // Which provider will serve each stage, so a caller can see before any
      // work happens whether this lesson will spend at a third party.
      generator: admission.generator,
      paidStages: admission.paidStages,
    }, { status: admitted.servedFromCache ? 200 : 202 });
  } catch (error) { return cloudLessonApiError(error); }
}
