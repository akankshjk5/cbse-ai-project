import { auth } from '@clerk/nextjs/server';
import { after, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { createClientWithFreshSessionToken } from '@/lib/supabase/server';
import {
  CreateLessonVideoSchema,
  LessonVideoProjectSchema,
} from '@/lib/videos/lesson-contracts';
import { videoLanguage } from '@/lib/videos/languages';
import { assertLocalVideoServicesReady } from '@/lib/videos/local-ai';
import { synthesizeNarration } from '@/lib/videos/narration';
import {
  adjustNarrationToFit,
  narrationFromPlan,
  planLesson,
  scenesForProject,
  translateLessonPlan,
} from '@/lib/videos/planner';

export const maxDuration = 300;

/**
 * The local planner is probabilistic: a plan that fails validation after its
 * in-call corrections gets one completely fresh attempt before the user sees
 * an error.
 */
async function planLessonWithRetry(input: Parameters<typeof planLesson>[0]) {
  try {
    return await planLesson(input);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    console.warn('[lesson-videos] lesson plan failed validation; retrying once', error.issues.slice(0, 5));
    return planLesson(input);
  }
}

async function prepareLesson(
  projectId: string,
  sessionId: string,
  input: ReturnType<typeof CreateLessonVideoSchema.parse>,
) {
  try {
    const supabase = createClientWithFreshSessionToken(sessionId);
    let sourcePlan = await planLessonWithRetry(input);
    const { data: current, error: statusError } = await supabase
      .from('lesson_video_projects')
      .select('status')
      .eq('id', projectId)
      .single();
    if (statusError) throw new Error(statusError.message);
    if (current?.status !== 'preparing') return;
    let plan = await translateLessonPlan(sourcePlan, input.languageCode);
    let narrationText = narrationFromPlan(plan);
    let narration = await synthesizeNarration(narrationText, input.languageCode);
    const minimumNarrationSeconds = input.targetDurationSeconds * 0.6;
    const maximumNarrationSeconds = input.targetDurationSeconds - 2;
    for (let revision = 0; revision < 2; revision += 1) {
      if (
        narration.durationSeconds >= minimumNarrationSeconds
        && narration.durationSeconds <= maximumNarrationSeconds
      ) break;
      try {
        sourcePlan = await adjustNarrationToFit(sourcePlan, {
          languageCode: input.languageCode,
          measuredDurationSeconds: narration.durationSeconds,
          targetDurationSeconds: input.targetDurationSeconds,
        });
      } catch (error) {
        // Assembly already time-fits narration that runs slightly long, so a
        // failed length edit must not cost the user the whole lesson.
        console.warn('[lesson-videos] narration length edit failed; keeping current narration', error);
        break;
      }
      plan = await translateLessonPlan(sourcePlan, input.languageCode);
      narrationText = narrationFromPlan(plan);
      narration = await synthesizeNarration(
        narrationText,
        input.languageCode,
        revision === 1 ? 'brisk' : 'natural',
      );
    }
    // The initial pass measures how naturally the speech fits. The final pass
    // renders each approved sentence into its own scene slot, so the audio
    // cannot drift away from the visuals later in the assembled lesson.
    narration = await synthesizeNarration(
      narrationText,
      input.languageCode,
      'natural',
      {
        sceneTranscripts: plan.scenes.map((scene) => scene.narration.trim()),
        targetDurationSeconds: input.targetDurationSeconds,
      },
    );
    const { data: created, error: createError } = await supabase.rpc(
      'complete_lesson_video_preparation',
      {
        p_project_id: projectId,
        p_learning_objective: plan.learningObjective,
        p_narration_text: narrationText,
        p_scenes: scenesForProject(plan),
        p_title: plan.title,
      },
    );
    if (createError) throw new Error(createError.message);
    const project = Array.isArray(created) ? created[0] : created;
    if (!project) throw new Error('Lesson video project was not created.');

    const audioPath = `${projectId}/narration.wav`;
    const { error: uploadError } = await supabase.storage
      .from('lesson-video-assets')
      .upload(audioPath, narration.wave, { contentType: 'audio/wav', upsert: false });
    if (uploadError) throw new Error(`Narration upload failed: ${uploadError.message}`);
    const narrationUrl = supabase.storage.from('lesson-video-assets').getPublicUrl(audioPath)
      .data.publicUrl;

    const { data: finalized, error: finalizeError } = await supabase.rpc(
      'set_lesson_video_narration',
      {
        p_narration_duration_seconds: narration.durationSeconds,
        p_narration_url: narrationUrl,
        p_project_id: projectId,
      },
    );
    if (finalizeError) throw new Error(finalizeError.message);
    const finalizedProject = Array.isArray(finalized) ? finalized[0] : finalized;
    LessonVideoProjectSchema.parse(finalizedProject ?? project);
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues.some((issue) => issue.path.includes('visualDescription'))
        ? 'The local visual planner could not create trustworthy text-free scenes for this topic. No clips were generated. Please try a more specific topic.'
        : 'The local lesson plan did not pass factual or format checks. No clips were generated. Please try a more specific topic.'
      : error instanceof Error ? error.message : 'Lesson setup failed.';
    try {
      const supabase = createClientWithFreshSessionToken(sessionId);
      const { error: recordError } = await supabase.rpc('fail_lesson_video_setup', {
        p_error_message: message,
        p_project_id: projectId,
      });
      if (recordError) console.error('[lesson-videos] could not record preparation failure', recordError);
    } catch (recordError) {
      console.error('[lesson-videos] could not record preparation failure', recordError);
    }
    console.error('[lesson-videos] preparation failed', error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session.userId || !session.sessionId) {
      return NextResponse.json(
        { error: 'Your session ended. Please sign in and try again.' },
        { status: 401 },
      );
    }
    const sessionId = session.sessionId;
    const input = CreateLessonVideoSchema.parse(await request.json());
    await assertLocalVideoServicesReady(session.userId);
    const supabase = createClientWithFreshSessionToken(sessionId);
    const { data: reserved, error: reserveError } = await supabase.rpc(
      'reserve_lesson_video_project',
      {
        p_class_level: input.classLevel,
        p_subject: input.subject,
        p_topic: input.topic,
        p_language_code: input.languageCode,
        p_language_name: videoLanguage(input.languageCode).label,
        p_target_duration_seconds: input.targetDurationSeconds,
      },
    );
    if (reserveError) throw new Error(reserveError.message);
    const project = LessonVideoProjectSchema.parse(
      Array.isArray(reserved) ? reserved[0] : reserved,
    );
    after(() => prepareLesson(project.id, sessionId, input));
    return NextResponse.json({ project }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Check the class, subject, topic, language and duration.' },
        { status: 400 },
      );
    }
    if (error instanceof Error && /\bJWT expired\b/i.test(error.message)) {
      return NextResponse.json(
        { error: 'Your session expired while preparing the lesson. Please sign in and try again.' },
        { status: 401 },
      );
    }
    if (error instanceof Error && error.message.startsWith('Video backend is not ready')) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error('[lesson-videos] create failed', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not start lesson generation.' },
      { status: 500 },
    );
  }
}
