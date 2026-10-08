'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';

import { Manager } from '@agents/manager';
import { withTelemetry } from '@agents/telemetry';

import { requireUserId } from '@/lib/auth/session';
import { assertDeckOwner } from '@/lib/data/decks';
import { getDraft, recordRevision } from '@/lib/data/drafts';
import { startJob } from '@/lib/data/generation';
import { runApprovedBuild } from '@/lib/generation/run';
import { checkBuildQuota } from '@/lib/limits';

/**
 * The review gate's two verbs: revise the outline, or approve it.
 *
 * Both re-check ownership server-side. The deck id arrives from the client, so
 * the fact that the panel only renders on the user's own deck is a courtesy,
 * not a control.
 */

export interface ReviseResult {
  error: string | null;
  /** What the planner says it changed, for the transcript. */
  reply?: string;
}

/** How long a revision instruction may be. Longer is a new deck, not an edit. */
const MAX_INSTRUCTION = 1000;

/**
 * Rewrites the outline to follow an instruction, and records the exchange.
 *
 * Runs inside the request rather than in `after()`: it is one model call on a
 * small context, the user is waiting for the result, and there is nothing
 * useful to show them until it lands.
 */
export async function reviseDraftAction(
  deckId: string,
  instruction: string,
): Promise<ReviseResult> {
  const userId = await requireUserId();

  const message = instruction.trim();
  if (!message) return { error: 'Say what you would like changed.' };
  if (message.length > MAX_INSTRUCTION) {
    return { error: `Keep it under ${MAX_INSTRUCTION} characters.` };
  }

  try {
    await assertDeckOwner(userId, deckId);

    const draft = await getDraft(userId, deckId);
    if (!draft) return { error: 'This deck has no outline waiting for review.' };
    if (!draft.research) {
      return { error: 'This outline is missing its research, so it cannot be revised safely.' };
    }

    const manager = new Manager({
      // The planner is being asked to edit an existing plan, so the brief is
      // the plan's own objective rather than the original form input.
      userRequest: draft.plan.objective,
      runId: `revise-${deckId}`,
    });

    let cost = 0;
    const result = await withTelemetry(
      (record) => {
        cost += record.costUsd ?? 0;
      },
      () => manager.revisePlan(draft.plan, draft.research!, message),
    );

    manager.dispose();

    if (!result.success || !result.plan) {
      return { error: result.error?.message ?? 'Could not revise the outline.' };
    }

    const reply = summariseChange(draft.plan, result.plan);
    await recordRevision(userId, deckId, { plan: result.plan, userMessage: message, reply });

    console.log(`[draft] ${deckId.slice(0, 8)} revised for $${cost.toFixed(4)}`);

    revalidatePath(`/app/decks/${deckId}`);
    return { error: null, reply };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A plain description of what the revision did.
 *
 * Written in code rather than asked for, because a model summarising its own
 * edit reports what it meant to do. Counting the slides reports what it did.
 */
function summariseChange(
  before: { slides: { number: number; keyMessage: string }[] },
  after: { slides: { number: number; keyMessage: string }[] },
): string {
  const delta = after.slides.length - before.slides.length;
  const parts: string[] = [];

  if (delta > 0) parts.push(`added ${delta} slide${delta === 1 ? '' : 's'}`);
  else if (delta < 0) parts.push(`removed ${-delta} slide${delta === -1 ? '' : 's'}`);

  const kept = new Set(before.slides.map((slide) => slide.keyMessage));
  const rewritten = after.slides.filter((slide) => !kept.has(slide.keyMessage)).length;
  const changed = delta > 0 ? rewritten - delta : rewritten;

  if (changed > 0) parts.push(`rewrote ${changed} slide${changed === 1 ? '' : 's'}`);

  return parts.length > 0
    ? `Updated the outline — ${parts.join(' and ')}. It now has ${after.slides.length} slides.`
    : `Kept the outline at ${after.slides.length} slides; nothing needed changing for that.`;
}

/**
 * Accepts the outline and starts the expensive half of the build.
 *
 * Opening the job happens inside the request — it needs the Clerk session to
 * check ownership, and it means a build that cannot start says so on the
 * button rather than leaving a card that never moves.
 */
export async function approveDraftAction(deckId: string): Promise<{ error: string | null }> {
  const userId = await requireUserId();

  try {
    await assertDeckOwner(userId, deckId);

    const draft = await getDraft(userId, deckId);
    if (!draft) return { error: 'This deck has no outline waiting for review.' };

    // The expensive half. Checked here so the refusal reaches the approval
    // screen as a sentence rather than as a failed job on a card.
    const quota = await checkBuildQuota(userId);
    if (quota) return { error: quota };

    const job = await startJob(userId, deckId, { approvedPlan: true });
    if (!job) return { error: 'Deck not found.' };

    after(() =>
      runApprovedBuild(userId, deckId, job.id, {
        plan: draft.plan,
        research: draft.research,
      }),
    );

    revalidatePath(`/app/decks/${deckId}`);
    revalidatePath('/app');
    return { error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generation] could not start approved build for ${deckId}: ${message}`);
    return { error: `Could not start the build: ${message}` };
  }
}
