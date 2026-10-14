import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
export function cloudLessonApiError(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ error: 'Check the class, subject, topic and language.' }, { status: 400 });
  const hint = error && typeof error === 'object' && 'hint' in error ? String(error.hint) : '';
  const messages: Record<string, [number, string]> = {
    cloud_lesson_auth: [401, 'Your session ended. Sign in again.'],
    cloud_lesson_invalid: [400, 'Check the class, subject, topic and language.'],
    cloud_lesson_active_limit: [429, 'Two lessons are already generating. Wait for one to finish.'],
    cloud_lesson_daily_limit: [429, 'You have reached the limit of ten lessons in twenty-four hours.'],
  };
  if (messages[hint]) return NextResponse.json({ error: messages[hint][1] }, { status: messages[hint][0] });
  console.error('[cloud-lessons] request failed', error);
  return NextResponse.json({ error: 'The lesson service could not complete this request. Check the cloud database setup and try again.' }, { status: 500 });
}
