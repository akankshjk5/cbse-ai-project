-- Human review between planning and building.
--
-- A deck used to go from "create" to a finished .pptx in one unattended run.
-- That is the wrong shape for the money involved: the research and the outline
-- together cost about a cent, and everything after them costs twenty to thirty
-- times that, almost all of it illustration. A user who wanted a different
-- deck found out only once the whole thing had been paid for and built.
--
-- So the build now stops after the outline and waits. `deck_drafts` holds what
-- there is at that point — the research brief, the content plan, and the
-- conversation the user has with the planner about it — until they approve.
--
-- One row per deck, replaced wholesale on each revision. There is no history
-- to keep: the plan under discussion is the only one that matters, and the
-- messages array carries the conversation that produced it.

alter type public.deck_status add value if not exists 'awaiting_review';

create table if not exists public.deck_drafts (
  deck_id    uuid primary key references public.decks (id) on delete cascade,
  -- Denormalised from decks so the RLS policy below is a column comparison
  -- rather than a join. Clerk user id, so text.
  owner_id   text not null,
  -- The ResearchBrief the plan was drawn from. Kept so a revision can be
  -- checked against the facts rather than inventing new ones, and so the build
  -- phase does not have to pay for research a second time.
  research   jsonb not null default '{}'::jsonb,
  -- The ContentPlan under review. Replaced in full by each revision.
  plan       jsonb not null,
  -- [{ role: 'user' | 'assistant', content: text, at: timestamptz }]
  messages   jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deck_drafts_owner_idx on public.deck_drafts (owner_id);

create trigger deck_drafts_set_updated_at
  before update on public.deck_drafts
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- The owner reads and writes their own drafts; the worker writes on the
-- service-role client, which bypasses this. Same shape as `decks`, and keyed
-- on `public.clerk_user_id()` rather than `auth.uid()` because Clerk ids are
-- text, not uuids.

alter table public.deck_drafts enable row level security;

create policy "deck_drafts: owner full access"
  on public.deck_drafts for all
  to authenticated
  using (owner_id = public.clerk_user_id())
  with check (owner_id = public.clerk_user_id());
