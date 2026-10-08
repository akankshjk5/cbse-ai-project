-- ─────────────────────────────────────────────────────────────────────────────
-- 0200 · Profiles
--
-- Clerk stores the person (email, name, avatar, MFA). This table stores only
-- what is ours: generation preferences and app state. Do not mirror Clerk
-- fields here — they go stale the moment a user edits their Clerk profile.
--
-- `id` is the Clerk user id (text). There is no foreign key, because the users
-- table lives at Clerk, not in this database. Rows are created lazily by
-- ensureProfile() in src/lib/data/profiles.ts, or by a Clerk webhook if you add
-- one (see the clerk-webhooks skill).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id           text primary key,
  preferences  jsonb not null default '{}'::jsonb,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles: owner full access"
  on public.profiles for all
  to authenticated
  using (id = public.clerk_user_id())
  with check (id = public.clerk_user_id());
