-- ─────────────────────────────────────────────────────────────────────────────
-- 0400 · Generation pipeline telemetry
--
-- One `generation_jobs` row per user-triggered build of a deck; one
-- `agent_runs` row per agent stage inside it. This is the audit trail: cost,
-- latency, prompts and raw model output for every one of the 13 agents.
--
-- `agent` is text, not an enum, on purpose — the roster changes more often than
-- we want to ship migrations. Known values live in Agents/runtime and are
-- mirrored in CLAUDE.md; keep the two in sync.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.run_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.generation_jobs (
  id           uuid primary key default extensions.gen_random_uuid(),
  deck_id      uuid not null references public.decks (id) on delete cascade,
  owner_id     text not null,
  status       public.run_status not null default 'queued',
  -- Human-readable current stage, e.g. 'outline' or 'image:hero'. Drives the
  -- progress UI; do not parse it in code, read agent_runs instead.
  stage        text,
  progress     numeric(5, 4) not null default 0 check (progress between 0 and 1),
  input        jsonb not null default '{}'::jsonb,
  error        text,
  -- Rolled up from agent_runs when the job finishes. Denormalised so the deck
  -- list can show cost without a join over every run.
  total_cost_usd numeric(10, 6) not null default 0,
  total_tokens   integer not null default 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists generation_jobs_deck_idx  on public.generation_jobs (deck_id, created_at desc);
create index if not exists generation_jobs_owner_idx on public.generation_jobs (owner_id, created_at desc);
-- Partial index: the worker polls only for live jobs.
create index if not exists generation_jobs_active_idx
  on public.generation_jobs (created_at)
  where status in ('queued', 'running');

create trigger generation_jobs_set_updated_at
  before update on public.generation_jobs
  for each row execute function public.set_updated_at();

create table if not exists public.agent_runs (
  id                uuid primary key default extensions.gen_random_uuid(),
  job_id            uuid not null references public.generation_jobs (id) on delete cascade,
  deck_id           uuid not null references public.decks (id) on delete cascade,
  slide_id          uuid references public.slides (id) on delete set null,
  agent             text not null,
  -- Retry counter for the same agent+slide. 0 is the first attempt.
  attempt           integer not null default 0 check (attempt >= 0),
  status            public.run_status not null default 'queued',
  model             text,
  input             jsonb not null default '{}'::jsonb,
  output            jsonb,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(10, 6),
  latency_ms        integer,
  error             text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists agent_runs_job_idx   on public.agent_runs (job_id, created_at);
create index if not exists agent_runs_agent_idx on public.agent_runs (agent, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Read-only for owners; all writes go through the service-role client in the
-- worker. Telemetry carries prompts, raw model output and cost, so there is no
-- public read path at all.

alter table public.generation_jobs enable row level security;
alter table public.agent_runs      enable row level security;

create policy "generation_jobs: read own"
  on public.generation_jobs for select
  to authenticated
  using (owner_id = public.clerk_user_id());

create policy "agent_runs: read own"
  on public.agent_runs for select
  to authenticated
  using (public.is_deck_owner(deck_id));

-- Realtime: the deck editor subscribes to job progress. This works now that the
-- browser carries a Clerk token Supabase can verify.
do $$ begin
  alter publication supabase_realtime add table public.generation_jobs;
exception when duplicate_object then null; end $$;
