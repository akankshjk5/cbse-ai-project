import 'server-only';

import { contentPlanSchema, researchBriefSchema } from '@agents/types';
import type { ContentPlan, ResearchBrief } from '@agents/types';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

/**
 * The outline a user is reviewing, and the conversation about it.
 *
 * Reads run on the Clerk-scoped client so RLS is the boundary; writes from the
 * background build run on the service role, because that worker outlives the
 * request that started it and has no session of its own. Every function here
 * takes a `userId` the caller has already established, and filters on it as
 * well — the same belt-and-braces rule as `data/decks.ts`.
 */

export interface DraftMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface DeckDraft {
  deckId: string;
  research: ResearchBrief | null;
  plan: ContentPlan;
  messages: DraftMessage[];
}

/**
 * Reads `messages` defensively.
 *
 * `jsonb` does not preserve the shape that was written, and this column is
 * appended to on every revision — one malformed entry from an older build
 * should cost that line, not the whole review screen.
 */
function parseMessages(value: unknown): DraftMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): DraftMessage[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { role, content, at } = entry as Record<string, unknown>;

    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return [];
    return [{ role, content, at: typeof at === 'string' ? at : new Date(0).toISOString() }];
  });
}

/** Opens (or replaces) the draft a deck is waiting on. Service role: the worker. */
export async function saveDraft(
  deckId: string,
  ownerId: string,
  input: { research: ResearchBrief; plan: ContentPlan },
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin.from('deck_drafts').upsert(
    {
      deck_id: deckId,
      owner_id: ownerId,
      research: input.research as unknown as Json,
      plan: input.plan as unknown as Json,
      messages: [] as unknown as Json,
    },
    { onConflict: 'deck_id' },
  );

  if (error) throw new Error(`saveDraft failed: ${error.message}`);

  await admin.from('decks').update({ status: 'awaiting_review' }).eq('id', deckId);
}

/**
 * The draft a user is reviewing, or null.
 *
 * Parsed through the pipeline's own schemas rather than cast: the column is
 * `jsonb`, so the validation the planner's output passed on the way in does
 * not survive the round trip, and a review screen that trusts `Json` crashes
 * on the first row written by an older build.
 */
export async function getDraft(userId: string, deckId: string): Promise<DeckDraft | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('deck_drafts')
    .select('*')
    .eq('deck_id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (error) throw new Error(`getDraft failed: ${error.message}`);
  if (!data) return null;

  const plan = contentPlanSchema.safeParse(data.plan);
  if (!plan.success) return null;

  const research = researchBriefSchema.safeParse(data.research);

  return {
    deckId: data.deck_id,
    plan: plan.data,
    research: research.success ? research.data : null,
    messages: parseMessages(data.messages),
  };
}

/**
 * Records one exchange and the plan it produced.
 *
 * The plan is replaced wholesale — a revision returns the complete outline,
 * not a patch, so there is nothing to merge. Both messages are appended in one
 * write so a failure cannot leave a question in the transcript with no answer.
 */
export async function recordRevision(
  userId: string,
  deckId: string,
  input: { plan: ContentPlan; userMessage: string; reply: string },
): Promise<void> {
  const supabase = await createClient();

  const { data: existing, error: readError } = await supabase
    .from('deck_drafts')
    .select('messages')
    .eq('deck_id', deckId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (readError) throw new Error(`recordRevision failed: ${readError.message}`);
  if (!existing) throw new Error('No draft to revise.');

  const at = new Date().toISOString();
  const messages: DraftMessage[] = [
    ...parseMessages(existing.messages),
    { role: 'user', content: input.userMessage, at },
    { role: 'assistant', content: input.reply, at },
  ];

  const { error } = await supabase
    .from('deck_drafts')
    .update({
      plan: input.plan as unknown as Json,
      messages: messages as unknown as Json,
    })
    .eq('deck_id', deckId)
    .eq('owner_id', userId);

  if (error) throw new Error(`recordRevision failed: ${error.message}`);
}

/**
 * Drops the draft once its deck has been built.
 *
 * The plan is on the slides by then, and a stale outline shown next to a
 * finished deck is worse than none — it invites edits that cannot take effect.
 */
export async function clearDraft(deckId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from('deck_drafts').delete().eq('deck_id', deckId);
}
