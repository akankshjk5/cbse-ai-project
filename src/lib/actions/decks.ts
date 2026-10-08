'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';

import type { Json } from '@/lib/supabase/types';
import { requireUserId } from '@/lib/auth/session';
import { isValidBoard } from '@/lib/boards';
import { assertDeckOwner, createDeck, deleteDeck, uploadReferenceImage } from '@/lib/data/decks';
import { startJob } from '@/lib/data/generation';
import { checkBuildQuota, checkDeckQuota } from '@/lib/limits';
import { runDeckDraft } from '@/lib/generation/run';
import { isTemplateId, templateStyleSpec } from '@/lib/templates';
import { referenceImageError } from '@/lib/uploads';

export type CreateDeckFormState = {
  error: string | null;
};

const GRADE_MIN = 1;
const GRADE_MAX = 10;
const SLIDE_COUNT_MIN = 4;
const SLIDE_COUNT_MAX = 30;

/**
 * Creates a deck from the "Create PPTX" form, stores the style reference image
 * if one was supplied, and starts the generation pipeline.
 *
 * The build runs in `after()` — it takes minutes, and holding the form's
 * request open for it would time out long before the deck was ready. The user
 * gets their deck card immediately in `generating` status, and the card follows
 * the job over Supabase Realtime from there.
 */
export async function createDeckAction(
  _prevState: CreateDeckFormState,
  formData: FormData,
): Promise<CreateDeckFormState> {
  const userId = await requireUserId();

  const topic = String(formData.get('topic') ?? '').trim();
  const subject = String(formData.get('subject') ?? '').trim();
  const board = String(formData.get('board') ?? '').trim();
  const language = String(formData.get('language') ?? 'en').trim();
  const gradeLevelRaw = Number(formData.get('gradeLevel'));
  const slideCountRaw = Number(formData.get('slideCount'));
  const referenceImage = formData.get('referenceImage');
  const templateRaw = String(formData.get('template') ?? '').trim();

  if (!topic) return { error: 'Topic is required.' };

  // Before anything is written or uploaded. A deck created and then refused a
  // build leaves a row and a reference image behind for the user to clean up,
  // and a limit that is felt at the end of a form is a limit that reads as a
  // bug.
  const quota = (await checkDeckQuota(userId)) ?? (await checkBuildQuota(userId));
  if (quota) return { error: quota };

  // A deck needs a design system before a slide can be written, and there are
  // exactly two ways to get one: pick a template, or hand the analyzer a
  // picture. Neither and the build would be created only to fail a minute
  // later in `analyzeStyle`, so it is refused here instead.
  const template = templateRaw === '' ? null : templateRaw;
  if (template !== null && !isTemplateId(template)) {
    return { error: 'That template does not exist.' };
  }

  const hasImage = referenceImage instanceof File && referenceImage.size > 0;
  if (!template && !hasImage) {
    return { error: 'Choose a template, or upload a reference image to match.' };
  }
  if (hasImage) {
    // Re-checked server-side: the dialog's own check is a courtesy to the
    // user, not a control. Anything larger never reaches here — the Server
    // Action body cap in next.config.ts rejects the request before this
    // function runs.
    const imageError = referenceImageError(referenceImage);
    if (imageError) return { error: imageError };
  }
  if (!subject) return { error: 'Subject is required.' };
  if (!isValidBoard(board)) return { error: 'Select a valid board.' };
  if (!Number.isInteger(gradeLevelRaw) || gradeLevelRaw < GRADE_MIN || gradeLevelRaw > GRADE_MAX) {
    return { error: `Class must be between ${GRADE_MIN} and ${GRADE_MAX}.` };
  }
  if (
    !Number.isInteger(slideCountRaw) ||
    slideCountRaw < SLIDE_COUNT_MIN ||
    slideCountRaw > SLIDE_COUNT_MAX
  ) {
    return { error: `Number of slides must be between ${SLIDE_COUNT_MIN} and ${SLIDE_COUNT_MAX}.` };
  }

  let deck;
  try {
    deck = await createDeck(userId, {
      title: topic,
      topic,
      subject,
      grade_level: gradeLevelRaw,
      board,
      language,
      requested_slide_count: slideCountRaw,
      source_prompt: `Class ${gradeLevelRaw} ${subject} (${board}): ${topic}`,
      // A template IS the deck's design system, already written out and
      // checked — so it goes straight into the column that holds one, rather
      // than being stored as a choice for a later stage to look up. The
      // pipeline reads it back in `openRun` and skips the analyzer entirely.
      // A reference-image deck leaves this empty and the analyzer fills it in.
      ...(template ? { style_spec: templateStyleSpec(template) as unknown as Json } : {}),
    });

    // Not when a template was chosen: the two are alternatives, and storing a
    // reference nothing will ever read only leaves a file to clean up.
    if (!template && hasImage) await uploadReferenceImage(userId, deck.id, referenceImage);
  } catch (error) {
    if (deck) await deleteDeck(userId, deck.id).catch(() => {});
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const started = await startGeneration(userId, deck.id);
  if (started.error) return { error: started.error };

  revalidatePath('/app');
  return { error: null };
}

/**
 * Opens the job inside the request, then hands the DRAFT to `after()`.
 *
 * The split matters. Opening the job needs the Clerk session (it checks
 * ownership on the user-scoped client), and `after()` runs once the response is
 * gone. It also means a deck that cannot even start — no service-role key, RLS
 * refusing the insert — says so in the form, instead of leaving a card that
 * never moves and a terminal with nothing in it.
 *
 * What runs is the draft phase only: research and an outline, about a cent's
 * worth, and then a stop. The deck lands in `awaiting_review` and waits for its
 * owner to approve the plan before anything expensive happens. `regenerate`
 * takes the same path — a rebuild is a new deck's worth of money, and deserves
 * the same look first.
 */
async function startGeneration(
  userId: string,
  deckId: string,
): Promise<{ error: string | null }> {
  let jobId: string;

  try {
    const job = await startJob(userId, deckId, {});
    if (!job) return { error: 'Deck not found.' };
    jobId = job.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generation] could not start job for ${deckId}: ${message}`);
    return { error: `Could not start generation: ${message}` };
  }

  after(() => runDeckDraft(userId, deckId, jobId));
  return { error: null };
}

/**
 * Deletes a deck and everything hanging off it.
 *
 * Ownership is re-checked server-side even though the button only appears on
 * the user's own cards — the deck id comes from the client.
 */
export async function deleteDeckAction(deckId: string): Promise<{ error: string | null }> {
  const userId = await requireUserId();

  try {
    await deleteDeck(userId, deckId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[decks] delete ${deckId} failed: ${message}`);
    return { error: message };
  }

  revalidatePath('/app');
  return { error: null };
}

/**
 * Re-runs the pipeline for an existing deck — the retry path for a build that
 * failed, and the "try again" for one the user is not happy with.
 *
 * Ownership is checked here even though the UI only offers the button on the
 * user's own cards: the deck id arrives from the client, so it is untrusted.
 */
export async function regenerateDeckAction(deckId: string): Promise<{ error: string | null }> {
  const userId = await requireUserId();

  try {
    await assertDeckOwner(userId, deckId);
  } catch {
    return { error: 'Deck not found.' };
  }

  // A rebuild is a new deck's worth of money, so it answers to the same rate
  // limit. Not the deck ceiling — this deck already exists and is already
  // counted.
  const quota = await checkBuildQuota(userId);
  if (quota) return { error: quota };

  const started = await startGeneration(userId, deckId);
  if (started.error) return started;

  revalidatePath('/app');
  return { error: null };
}
